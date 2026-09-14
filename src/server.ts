import { access, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
    JsonObject,
    JsonValue,
    PiWebServerPlugin,
    ProjectInput,
    ProviderClaim,
    ProviderRemoveContext,
    ProviderRequestContext,
    ProviderWorkspace,
    ServerPluginActivationContext,
    ServerPluginExecFileResult,
    ServerPluginHealth,
    WorkspaceProvider,
    WorkspaceRemovePlan,
} from '@jmfederico/pi-web/server-plugin-api';

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_NAME = 'default';
const STACK_REVSET = 'trunk() | (trunk()..@) | @::';
const MAX_PATCH_CHARS = 1_000_000;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Revisions accepted from the browser: change/commit ids, `@`, `@-`, `trunk()`,
// bookmark names. Argv-only so there is no shell risk; this just keeps revsets
// small and predictable.
const REVISION_RE = /^[A-Za-z0-9@_.()\-/]{1,80}$/;

interface Settings {
    jjPath: string;
    workspaceBaseDir: string | undefined;
}

const plugin: PiWebServerPlugin = {
    apiVersion: 1,
    name: 'Jujutsu',
    async activate(context) {
        const settings = readSettings(context.settings);
        context.logger.info('Activating jj workspace provider', {
            pluginId: context.pluginId,
            jjPath: settings.jjPath,
        });
        const jj = createRunner(context, settings);
        let version: string | undefined;
        try {
            const result = await jj(undefined, ['--version'], context.signal);
            version = result.stdout.trim();
            context.logger.info('jj available', { version });
        } catch (error) {
            context.logger.warn('jj is not available; provider will report unhealthy', { error: errorMessage(error) });
        }
        return {
            workspaceProvider: createWorkspaceProvider(jj, settings),
            health(): ServerPluginHealth {
                return version === undefined
                    ? { status: 'unhealthy', message: `jj executable not found (${settings.jjPath})` }
                    : { status: 'healthy', message: version };
            },
        };
    },
};

export default plugin;

function readSettings(raw: JsonObject): Settings {
    const jjPath = typeof raw['jjPath'] === 'string' && raw['jjPath'] !== '' ? raw['jjPath'] : 'jj';
    const base = raw['workspaceBaseDir'];
    return { jjPath, workspaceBaseDir: typeof base === 'string' && base !== '' ? base : undefined };
}

// ---------------------------------------------------------------------------
// jj runner
// ---------------------------------------------------------------------------

interface RunOptions {
    /** Allow jj to snapshot the working copy (creates an operation). Default: false. */
    snapshot?: boolean;
    timeoutMs?: number;
}

type JjRunner = (
    cwd: string | undefined,
    args: readonly string[],
    signal: AbortSignal,
    options?: RunOptions,
) => Promise<ServerPluginExecFileResult>;

function createRunner(context: ServerPluginActivationContext, settings: Settings): JjRunner {
    return async (cwd, args, signal, options = {}) => {
        signal.throwIfAborted();
        const globalArgs = ['--no-pager', '--color=never', '--quiet'];
        if (options.snapshot !== true) globalArgs.push('--ignore-working-copy');
        const result = await context.execFile({
            file: settings.jjPath,
            args: [...globalArgs, ...args],
            ...(cwd === undefined ? {} : { cwd }),
            // Never let jj open an editor or pager.
            env: { JJ_EDITOR: 'false', EDITOR: 'false', VISUAL: 'false' },
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            signal,
        });
        if (result.signal !== null) throw new Error(`jj ${args[0] ?? ''} ended from signal ${result.signal}`);
        return result;
    };
}

async function requireJj(run: Promise<ServerPluginExecFileResult>, what: string): Promise<ServerPluginExecFileResult> {
    const result = await run;
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;
        throw new Error(`Could not ${what}: ${firstLine(detail)}`);
    }
    return result;
}

// ---------------------------------------------------------------------------
// jj output parsing
// ---------------------------------------------------------------------------

/** Template producing one compact JSON object per commit, one per line. */
const COMMIT_TEMPLATE = [
    '"{"',
    '"\\"change\\":" ++ json(change_id.shortest(8))',
    '",\\"changeFull\\":" ++ json(change_id)',
    '",\\"commit\\":" ++ json(commit_id.short(8))',
    '",\\"commitFull\\":" ++ json(commit_id)',
    '",\\"description\\":" ++ json(description.first_line())',
    '",\\"bookmarks\\":" ++ json(bookmarks.map(|b| b.name()))',
    '",\\"parents\\":" ++ json(parents.map(|p| p.change_id().shortest(8)))',
    '",\\"isWorkingCopy\\":" ++ json(current_working_copy)',
    '",\\"conflict\\":" ++ json(conflict)',
    '",\\"empty\\":" ++ json(empty)',
    '",\\"immutable\\":" ++ json(immutable)',
    '",\\"author\\":" ++ json(author.name())',
    '",\\"timestamp\\":" ++ json(committer.timestamp().format("%Y-%m-%dT%H:%M:%S%:z"))',
    '"}\\n"',
].join(' ++ ');

interface Commit {
    change: string;
    /** Length of the unique prefix of `change` (for highlighting). */
    changePrefix: number;
    changeFull: string;
    commit: string;
    commitFull: string;
    description: string;
    bookmarks: string[];
    parents: string[];
    isWorkingCopy: boolean;
    conflict: boolean;
    empty: boolean;
    immutable: boolean;
    author: string;
    timestamp: string;
}

function parseCommits(stdout: string): Commit[] {
    const commits: Commit[] = [];
    for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        const raw = JSON.parse(line) as Record<string, unknown>;
        const change = shortId(raw['change']);
        commits.push({
            change: change.id,
            changePrefix: change.prefix,
            changeFull: str(raw['changeFull']),
            commit: str(raw['commit']),
            commitFull: str(raw['commitFull']),
            description: str(raw['description']),
            bookmarks: strList(raw['bookmarks']),
            parents: Array.isArray(raw['parents']) ? raw['parents'].map((p) => shortId(p).id) : [],
            isWorkingCopy: raw['isWorkingCopy'] === true,
            conflict: raw['conflict'] === true,
            empty: raw['empty'] === true,
            immutable: raw['immutable'] === true,
            author: str(raw['author']),
            timestamp: str(raw['timestamp']),
        });
    }
    return commits;
}

function commitToJson(commit: Commit): JsonObject {
    return { ...commit };
}

interface WorkspaceEntry {
    name: string;
    commitId: string;
    changeId: string;
}

function parseWorkspaceList(stdout: string): WorkspaceEntry[] {
    const entries: WorkspaceEntry[] = [];
    for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        const raw = JSON.parse(line) as { name?: unknown; target?: { commit_id?: unknown; change_id?: unknown } };
        entries.push({
            name: str(raw.name),
            commitId: str(raw.target?.commit_id),
            changeId: str(raw.target?.change_id),
        });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Workspace provider
// ---------------------------------------------------------------------------

interface ResolvedWorkspaces {
    live: Array<{ entry: WorkspaceEntry; path: string; commit: Commit | undefined }>;
    stale: string[];
}

function createWorkspaceProvider(jj: JjRunner, settings: Settings): WorkspaceProvider {
    async function resolveWorkspaces(project: ProjectInput, signal: AbortSignal): Promise<ResolvedWorkspaces> {
        const listResult = await requireJj(
            jj(project.path, ['workspace', 'list', '-T', 'json(self) ++ "\\n"'], signal),
            'list jj workspaces',
        );
        const entries = parseWorkspaceList(listResult.stdout);
        if (entries.length === 0) throw new Error('jj returned no workspaces');

        // One log call for every working-copy commit, matched by commit id.
        let commitsById = new Map<string, Commit>();
        try {
            const logResult = await requireJj(
                jj(project.path, ['log', '--no-graph', '-r', 'working_copies()', '-T', COMMIT_TEMPLATE], signal),
                'describe jj working copies',
            );
            commitsById = new Map(parseCommits(logResult.stdout).map((c) => [c.commitFull, c]));
        } catch {
            // Metadata is decorative; keep listing even if this fails.
        }

        const live: ResolvedWorkspaces['live'] = [];
        const stale: string[] = [];
        for (const entry of entries) {
            signal.throwIfAborted();
            const rootResult = await jj(project.path, ['workspace', 'root', '--name', entry.name], signal);
            const root = rootResult.exitCode === 0 ? rootResult.stdout.trim() : '';
            if (root === '' || !(await isDirectory(root))) {
                stale.push(entry.name);
                continue;
            }
            live.push({ entry, path: resolve(root), commit: commitsById.get(entry.commitId) });
        }
        return { live, stale };
    }

    function workspaceBaseDir(project: ProjectInput): string {
        if (settings.workspaceBaseDir !== undefined) {
            return join(
                settings.workspaceBaseDir.replace(/^~(?=\/|$)/, process.env['HOME'] ?? '~'),
                basename(project.path),
            );
        }
        return join(dirname(project.path), '.jj-workspaces', basename(project.path));
    }

    return {
        async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
            signal.throwIfAborted();
            try {
                const s = await stat(join(project.path, '.jj'));
                return s.isDirectory() ? 'claim' : 'pass';
            } catch (error) {
                if (isMissingFile(error)) return 'pass';
                throw error;
            }
        },

        async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
            const { live, stale } = await resolveWorkspaces(project, signal);
            const hasDefault = live.some(({ entry }) => entry.name === DEFAULT_WORKSPACE_NAME);
            return live.map(({ entry, path, commit }, index) => {
                // `default` is main; if it is somehow gone, promote the first live one.
                const isMain = hasDefault ? entry.name === DEFAULT_WORKSPACE_NAME : index === 0;
                const publicMetadata: JsonObject = {
                    workspace: entry.name,
                    change: commit?.change ?? entry.changeId.slice(0, 8),
                    commit: commit?.commit ?? entry.commitId.slice(0, 8),
                    description: commit?.description ?? '',
                    bookmarks: commit?.bookmarks ?? [],
                    conflict: commit?.conflict ?? false,
                    empty: commit?.empty ?? true,
                    ...(isMain ? { staleWorkspaces: stale } : {}),
                };
                return {
                    key: entry.name,
                    path,
                    label: isMain ? project.name : entry.name,
                    isMain,
                    data: { name: entry.name },
                    publicMetadata,
                    ...(isMain
                        ? {}
                        : {
                              removal: {
                                  actionLabel: 'Forget jj workspace',
                                  confirmation: `Forget jj workspace "${entry.name}" and delete ${path}? Commits stay in the repo; only the working copy directory is removed.`,
                              },
                          }),
                };
            });
        },

        async request(context: ProviderRequestContext): Promise<JsonValue> {
            const { project, workspace, operation, input, signal } = context;
            signal.throwIfAborted();
            const cwd = workspace.path;
            const inputObject = isJsonObject(input) ? input : {};

            switch (operation) {
                case 'status': {
                    const logResult = await requireJj(
                        jj(cwd, ['log', '--no-graph', '-r', STACK_REVSET, '-T', COMMIT_TEMPLATE], signal),
                        'read the jj stack',
                    );
                    const stack = parseCommits(logResult.stdout);
                    const where = stack.find((c) => c.isWorkingCopy);
                    // Conflicts anywhere in the mutable graph (a `jj pull` rebases every stack).
                    let conflicts: Commit[] = [];
                    try {
                        const conflictResult = await requireJj(
                            jj(
                                cwd,
                                ['log', '--no-graph', '-r', 'conflicts() & mutable()', '-T', COMMIT_TEMPLATE],
                                signal,
                            ),
                            'list conflicted changes',
                        );
                        conflicts = parseCommits(conflictResult.stdout);
                    } catch {
                        // decorative
                    }
                    const { stale } = await resolveWorkspaces(project, signal).catch(() => ({ stale: [] as string[] }));
                    return {
                        workspace: workspace.key,
                        where: where === undefined ? null : commitToJson(where),
                        stack: stack.map(commitToJson),
                        conflicts: conflicts.map(commitToJson),
                        staleWorkspaces: stale,
                    };
                }

                case 'diff': {
                    const args = ['diff', '--git'];
                    const revision = optionalRevision(inputObject, 'revision');
                    const from = optionalRevision(inputObject, 'from');
                    const to = optionalRevision(inputObject, 'to');
                    if (from !== undefined || to !== undefined) {
                        args.push('--from', from ?? 'trunk()', '--to', to ?? '@');
                    } else {
                        args.push('-r', revision ?? '@');
                    }
                    const path = inputObject['path'];
                    if (typeof path === 'string' && path !== '') args.push('--', path);
                    const result = await requireJj(jj(cwd, args, signal), 'compute the jj diff');
                    const truncated = result.stdoutTruncated || result.stdout.length > MAX_PATCH_CHARS;
                    return { patch: result.stdout.slice(0, MAX_PATCH_CHARS), truncated };
                }

                case 'files': {
                    const args = ['diff', '--summary'];
                    const revision = optionalRevision(inputObject, 'revision');
                    const from = optionalRevision(inputObject, 'from');
                    const to = optionalRevision(inputObject, 'to');
                    if (from !== undefined || to !== undefined) {
                        args.push('--from', from ?? 'trunk()', '--to', to ?? '@');
                    } else {
                        args.push('-r', revision ?? '@');
                    }
                    const result = await requireJj(jj(cwd, args, signal), 'list changed files');
                    return result.stdout
                        .split('\n')
                        .filter((line) => line.trim() !== '')
                        .map((line) => ({ status: line.slice(0, 1), path: line.slice(2) }));
                }

                case 'oplog': {
                    const limit = clampInt(inputObject['limit'], 1, 100, 20);
                    const result = await requireJj(
                        jj(
                            cwd,
                            ['op', 'log', '--no-graph', '--limit', String(limit), '-T', 'json(self) ++ "\\n"'],
                            signal,
                        ),
                        'read the jj operation log',
                    );
                    return result.stdout
                        .split('\n')
                        .filter((line) => line.trim() !== '')
                        .map((line) => {
                            const raw = JSON.parse(line) as Record<string, unknown>;
                            const time = isJsonObject(raw['time']) ? raw['time'] : {};
                            return {
                                id: str(raw['id']).slice(0, 12),
                                description: str(raw['description']),
                                time: str(time['end'] ?? time['start']),
                                snapshot: raw['is_snapshot'] === true,
                                workspace: str(raw['workspace_name']),
                            };
                        });
                }

                case 'snapshot': {
                    // The one read that deliberately lets jj snapshot the working copy.
                    await requireJj(jj(cwd, ['status'], signal, { snapshot: true }), 'snapshot the working copy');
                    return { ok: true };
                }

                case 'workspace.add': {
                    const name = requireWorkspaceName(inputObject['name']);
                    const revision = optionalRevision(inputObject, 'revision');
                    const baseDir = workspaceBaseDir(project);
                    const destination = join(baseDir, name);
                    if (await exists(destination)) throw new Error(`Destination already exists: ${destination}`);
                    await mkdir(baseDir, { recursive: true });
                    const args = ['workspace', 'add', destination, '--name', name];
                    if (revision !== undefined) args.push('-r', revision);
                    // jj refuses `workspace add` under --ignore-working-copy; this is a
                    // user-initiated mutation, so snapshotting the main working copy is expected.
                    await requireJj(
                        jj(project.path, args, signal, { snapshot: true, timeoutMs: 25_000 }),
                        `add jj workspace "${name}"`,
                    );
                    return { name, path: destination };
                }

                case 'workspace.forget': {
                    const name = requireWorkspaceName(inputObject['name']);
                    if (name === DEFAULT_WORKSPACE_NAME) throw new Error('The default workspace cannot be forgotten');
                    await requireJj(
                        jj(project.path, ['workspace', 'forget', name], signal),
                        `forget jj workspace "${name}"`,
                    );
                    return { ok: true, name };
                }

                default:
                    throw new Error(`Unsupported jj workspace operation: ${operation}`);
            }
        },

        async prepareRemove({ project, workspace, signal }: ProviderRemoveContext): Promise<WorkspaceRemovePlan> {
            signal.throwIfAborted();
            const name = workspace.key;
            if (workspace.isMain || name === DEFAULT_WORKSPACE_NAME) {
                throw new Error('The default jj workspace cannot be removed');
            }
            if (!WORKSPACE_NAME_RE.test(name))
                throw new Error(`Refusing to remove workspace with unexpected name: ${name}`);
            // Re-validate against the live list so we never rm -rf a path jj no longer owns.
            const { live } = await resolveWorkspaces(project, signal);
            const current = live.find(({ entry }) => entry.name === name);
            if (current === undefined) throw new Error(`jj workspace "${name}" is no longer listed`);
            if (current.path !== workspace.path) {
                throw new Error(`jj workspace "${name}" path changed (${current.path}); refresh and retry`);
            }
            if (current.path === project.path || project.path.startsWith(current.path + '/')) {
                throw new Error('Refusing to delete a directory containing the project');
            }
            const jjBin = shellQuote(settings.jjPath);
            return {
                title: `Forget jj workspace: ${name}`,
                command:
                    `${jjBin} --ignore-working-copy -R ${shellQuote(project.path)} workspace forget ${shellQuote(name)}` +
                    ` && rm -rf -- ${shellQuote(workspace.path)}`,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function optionalRevision(input: JsonObject, key: string): string | undefined {
    const value = input[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !REVISION_RE.test(value)) throw new Error(`Invalid revision for "${key}"`);
    return value;
}

function requireWorkspaceName(value: JsonValue | undefined): string {
    if (typeof value !== 'string' || !WORKSPACE_NAME_RE.test(value)) {
        throw new Error("Workspace name must be 1-64 characters: letters, digits, '.', '_' or '-'");
    }
    return value;
}

function clampInt(value: JsonValue | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `shortest()` renders as `{prefix, rest}` in json(); plain strings also accepted. */
function shortId(value: unknown): { id: string; prefix: number } {
    if (typeof value === 'string') return { id: value, prefix: value.length };
    if (isJsonObject(value)) {
        const prefix = str(value['prefix']);
        return { id: prefix + str(value['rest']), prefix: prefix.length };
    }
    return { id: '', prefix: 0 };
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function firstLine(text: string): string {
    return text.split('\n')[0] ?? text;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function isMissingFile(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && Reflect.get(error, 'code') === 'ENOENT';
}
