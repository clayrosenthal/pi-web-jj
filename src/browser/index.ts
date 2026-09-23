import type {
    JsonObject,
    JsonValue,
    PiWebPlugin,
    PluginRuntimeContext,
    WorkspaceLabelItem,
    WorkspacePanelContext,
} from '@jmfederico/pi-web/plugin-api';

// ---------------------------------------------------------------------------
// Types mirrored from the server module (kept loose: everything is validated)
// ---------------------------------------------------------------------------

interface Commit {
    change: string;
    changePrefix: number;
    commit: string;
    description: string;
    bookmarks: string[];
    isWorkingCopy: boolean;
    conflict: boolean;
    empty: boolean;
    immutable: boolean;
    author: string;
    timestamp: string;
}

interface Status {
    workspace: string;
    where: Commit | null;
    stack: Commit[];
    conflicts: Commit[];
    staleWorkspaces: string[];
}

interface ChangedFile {
    status: string;
    path: string;
}

interface OpLogEntry {
    id: string;
    description: string;
    time: string;
    snapshot: boolean;
    workspace: string;
}

type DiffTarget = { revision: string } | { from: string; to: string };

interface PanelState {
    status?: Status;
    statusLoading: boolean;
    diffTarget?: DiffTarget;
    diffLabel?: string;
    files?: ChangedFile[];
    patch?: string;
    patchTruncated: boolean;
    diffLoading: boolean;
    selectedFile: string | undefined;
    view: 'stack' | 'oplog';
    oplog?: OpLogEntry[];
    error: string | undefined;
    busy: string | undefined;
    initialized: boolean;
}

const states = new Map<string, PanelState>();

function stateFor(context: WorkspacePanelContext): PanelState {
    const key = stateKey(context);
    let state = states.get(key);
    if (state === undefined) {
        state = {
            statusLoading: false,
            diffLoading: false,
            patchTruncated: false,
            view: 'stack',
            initialized: false,
            selectedFile: undefined,
            error: undefined,
            busy: undefined,
        };
        states.set(key, state);
    }
    return state;
}

function stateKey(context: WorkspacePanelContext): string {
    return `${context.machine.id}:${context.workspace.id}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const PANEL_ID = 'workspace.jj';

const plugin: PiWebPlugin = {
    apiVersion: 4,
    name: 'Jujutsu',
    activate: ({ pluginId, runtimePluginId, html, svg }) => {
        const owns = (workspace: { provider?: { pluginId: string } } | undefined): boolean =>
            workspace?.provider?.pluginId === pluginId;
        const qualifiedPanelId = `${runtimePluginId}:${PANEL_ID}`;

        return {
            contributions: {
                actions: [
                    {
                        id: 'open',
                        title: 'jj: Open panel',
                        group: 'jj',
                        enabled: ({ state }) => owns(state.selectedWorkspace),
                        run: ({ selectWorkspaceTool }) => {
                            selectWorkspaceTool(qualifiedPanelId);
                        },
                    },
                    {
                        id: 'workspace.add',
                        title: 'jj: New workspace',
                        description: 'Create a jj workspace (jj workspace add) and list it here',
                        group: 'jj',
                        enabled: ({ state }) => owns(state.selectedWorkspace),
                        run: async (runtime) => {
                            await addWorkspaceFromPrompt(runtime, qualifiedPanelId);
                        },
                    },
                    {
                        id: 'refresh',
                        title: 'jj: Refresh panel',
                        group: 'jj',
                        enabled: ({ state }) => owns(state.selectedWorkspace),
                        run: ({ refreshWorkspacePanels }) => refreshWorkspacePanels(qualifiedPanelId),
                    },
                    {
                        id: 'pull-resolve',
                        title: 'jj: Pull and resolve conflicts (agent)',
                        description:
                            'Insert a prompt asking the agent to run `jj pull` and resolve any conflicts using the jj-pull skill',
                        group: 'jj',
                        enabled: ({ state }) => owns(state.selectedWorkspace),
                        run: (runtime) => {
                            const workspace = runtime.state.selectedWorkspace;
                            if (workspace === undefined) return;
                            runtime.prompt.insertText(pullResolvePrompt(workspace.path, undefined));
                            runtime.focusPrompt();
                        },
                    },
                ],

                workspaceLabels: [
                    {
                        id: 'change',
                        order: 10,
                        visible: ({ workspace }) => owns(workspace),
                        items: ({ workspace }): WorkspaceLabelItem[] => {
                            const meta = workspace.provider?.metadata;
                            const change = metaString(meta, 'change');
                            if (change === '') return [];
                            const bookmarks = metaStringList(meta, 'bookmarks');
                            const description = metaString(meta, 'description');
                            const conflict = meta?.['conflict'] === true;
                            const text = [
                                `@ ${change}`,
                                ...(bookmarks.length > 0 ? [bookmarks.join(' ')] : []),
                                ...(conflict ? ['⚠ conflict'] : []),
                            ].join(' · ');
                            return [
                                { type: 'text', text, title: description === '' ? '(no description)' : description },
                            ];
                        },
                    },
                ],

                workspacePanels: [
                    {
                        id: PANEL_ID,
                        title: 'jj',
                        order: 20,
                        icon: svg`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="3" r="1.8"/><circle cx="8" cy="13" r="1.8"/><path d="M8 4.8v6.4"/><circle cx="12.5" cy="8" r="1.6"/><path d="M8 8h2.9"/></svg>`,
                        visible: ({ workspace }) => owns(workspace),
                        badge: (context) => {
                            const s = states.get(stateKey(context));
                            if ((s?.status?.conflicts.length ?? 0) > 0) return '!';
                            const n = s?.status?.stack.filter((c) => !c.immutable && !c.empty).length ?? 0;
                            return n > 0 ? n : undefined;
                        },
                        // Refresh on manual invalidation and whenever the host reports
                        // workspace file changes (agent edits, terminal commands).
                        invalidationResources: ['workspace.files'],
                        onInvalidate: async (context) => {
                            await loadStatus(context, { reloadDiff: true });
                        },
                        render: (context) => {
                            const state = stateFor(context);
                            lastPanelContext.set(context.workspace.id, context);
                            if (!state.initialized && hasPeer(context)) {
                                state.initialized = true;
                                void loadStatus(context, { reloadDiff: false });
                            }
                            return renderPanel(context, state, html);
                        },
                    },
                ],
            },
        };
    },
};

export default plugin;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Html = Parameters<PiWebPlugin['activate']>[0]['html'];

function renderPanel(context: WorkspacePanelContext, state: PanelState, html: Html) {
    const backendMissing = !hasPeer(context);
    const status = state.status;
    return html`
        <style .textContent=${panelStyles}></style>
        <div class="jj-panel">
            <section class="jj-toolbar">
                <strong>jj</strong>
                <span class="jj-muted"
                    >${metaString(context.workspace.provider?.metadata, 'workspace') || context.workspace.label}</span
                >
                <span class="jj-spacer"></span>
                <div class="jj-toggle" role="tablist">
                    <button
                        class=${state.view === 'stack' ? 'is-selected' : ''}
                        @click=${() => {
                            state.view = 'stack';
                            context.host.requestRender();
                        }}
                    >
                        Stack
                    </button>
                    <button
                        class=${state.view === 'oplog' ? 'is-selected' : ''}
                        @click=${() => {
                            state.view = 'oplog';
                            void loadOpLog(context);
                        }}
                    >
                        Op log
                    </button>
                </div>
                <button
                    title="jj pull: fetch all remotes and rebase mutable changes onto trunk() (runs in the terminal)"
                    ?disabled=${state.busy !== undefined}
                    @click=${() => {
                        void runPull(context);
                    }}
                >
                    Pull
                </button>
                <button
                    title="Snapshot the working copy now (jj status)"
                    ?disabled=${backendMissing || state.busy !== undefined}
                    @click=${() => {
                        void runBusy(context, 'Snapshotting…', 'snapshot', null);
                    }}
                >
                    Snapshot
                </button>
                <button
                    title="Refresh"
                    ?disabled=${backendMissing || state.statusLoading}
                    @click=${() => {
                        void loadStatus(context, { reloadDiff: true });
                    }}
                >
                    ${state.statusLoading ? '…' : 'Refresh'}
                </button>
            </section>

            ${backendMissing ? html`<div class="jj-error">The jj backend is not active. Restart pi-web-sessiond and reload.</div>` : ''}
            ${state.error === undefined ? '' : html`<div class="jj-error">${state.error}</div>`}
            ${state.busy === undefined ? '' : html`<div class="jj-notice">${state.busy}</div>`}
            ${renderConflicts(context, status, html)}
            ${state.view === 'oplog' ? renderOpLog(state, html) : renderStack(context, state, status, html)}
        </div>
    `;
}

function renderConflicts(context: WorkspacePanelContext, status: Status | undefined, html: Html) {
    const conflicts = status?.conflicts ?? [];
    if (conflicts.length === 0) return '';
    return html`
        <div class="jj-conflicts">
            <span
                ><strong>${conflicts.length} conflicted change${conflicts.length === 1 ? '' : 's'}:</strong>
                ${conflicts.map((c) => html` <code class="jj-change">${c.change}</code>`)}</span
            >
            <span class="jj-spacer"></span>
            <button
                title="Insert a prompt asking the agent to resolve these conflicts with the jj-pull skill"
                @click=${() => {
                    context.prompt.insertText(
                        pullResolvePrompt(
                            context.workspace.path,
                            conflicts.map((c) => c.change),
                        ),
                    );
                }}
            >
                Resolve with agent
            </button>
        </div>
    `;
}

function renderStack(context: WorkspacePanelContext, state: PanelState, status: Status | undefined, html: Html) {
    if (status === undefined) {
        return html`<section class="jj-body">
            <p class="jj-muted">${state.statusLoading ? 'Loading…' : 'No status yet.'}</p>
        </section>`;
    }
    const where = status.where;
    return html`
        <section class="jj-where">
            ${
                where === null
                    ? html`<span class="jj-muted">Working copy not in stack</span>`
                    : html`<span class="jj-muted">@</span> ${renderChangeId(where, html)}
                          ${where.bookmarks.map((b) => html`<span class="jj-bookmark">${b}</span>`)}
                          ${where.conflict ? html`<span class="jj-conflict">conflict</span>` : ''}
                          ${where.empty ? html`<span class="jj-tag">empty</span>` : ''}
                          <span class="jj-desc"
                              >${where.description === '' ? html`<em class="jj-muted">(no description)</em>` : where.description}</span
                          >`
            }
            <span class="jj-spacer"></span>
            <button
                class="jj-link"
                @click=${() => {
                    void loadDiff(context, { from: 'trunk()', to: '@' }, 'trunk() → @');
                }}
            >
                diff vs trunk
            </button>
        </section>

        <section class="jj-stack">
            ${status.stack.map((commit) => renderStackRow(context, state, commit, html))}
        </section>

        ${
            status.staleWorkspaces.length === 0
                ? ''
                : html` <section class="jj-stale">
                      <span>Stale workspaces (directory missing):</span>
                      ${status.staleWorkspaces.map(
                          (name) => html`
                              <span class="jj-tag">${name}</span>
                              <button
                                  class="jj-link"
                                  @click=${() => {
                                      void runBusy(context, `Forgetting ${name}…`, 'workspace.forget', { name });
                                  }}
                              >
                                  forget
                              </button>
                          `,
                      )}
                  </section>`
        }
        ${renderDiff(context, state, html)}
    `;
}

function renderStackRow(context: WorkspacePanelContext, state: PanelState, commit: Commit, html: Html) {
    const selected =
        state.diffTarget !== undefined && 'revision' in state.diffTarget && state.diffTarget.revision === commit.change;
    return html`
        <button
            class="jj-row ${selected ? 'is-selected' : ''} ${commit.immutable ? 'is-immutable' : ''}"
            title=${`${commit.commit} · ${commit.author} · ${commit.timestamp}`}
            @click=${() => {
                void loadDiff(context, { revision: commit.change }, commit.change);
            }}
        >
            <span class="jj-glyph"
                >${commit.isWorkingCopy ? '@' : commit.immutable ? '◆' : commit.conflict ? '×' : '○'}</span
            >
            ${renderChangeId(commit, html)} ${commit.bookmarks.map((b) => html`<span class="jj-bookmark">${b}</span>`)}
            ${commit.conflict ? html`<span class="jj-conflict">conflict</span>` : ''}
            ${commit.empty && !commit.immutable ? html`<span class="jj-tag">empty</span>` : ''}
            <span class="jj-desc"
                >${commit.description === '' ? html`<em class="jj-muted">(no description)</em>` : commit.description}</span
            >
        </button>
    `;
}

function renderChangeId(commit: Commit, html: Html) {
    const prefix = commit.change.slice(0, commit.changePrefix);
    const rest = commit.change.slice(commit.changePrefix);
    return html`<code class="jj-change"><b>${prefix}</b>${rest}</code>`;
}

function renderDiff(context: WorkspacePanelContext, state: PanelState, html: Html) {
    if (state.diffTarget === undefined) {
        return html`<section class="jj-body jj-muted">Select a change to see its diff.</section>`;
    }
    const files = state.files ?? [];
    return html`
        <section class="jj-diff">
            <header class="jj-diff-header">
                <span
                    >Diff:
                    <code>${state.diffLabel}</code
                    >${state.diffLoading ? html` <span class="jj-muted">loading…</span>` : ''}</span
                >
                <span class="jj-muted"
                    >${files.length}
                    file${files.length === 1 ? '' : 's'}${state.patchTruncated ? ' · truncated' : ''}</span
                >
                <button
                    class="jj-link"
                    @click=${() => {
                        insertDiffContext(context, state);
                    }}
                >
                    → prompt
                </button>
            </header>
            ${
                files.length === 0
                    ? ''
                    : html` <div class="jj-files">
                          <button
                              class="jj-file ${state.selectedFile === undefined ? 'is-selected' : ''}"
                              @click=${() => {
                                  state.selectedFile = undefined;
                                  void loadPatch(context, state);
                              }}
                          >
                              all files
                          </button>
                          ${files.map(
                              (f) =>
                                  html` <button
                                      class="jj-file ${state.selectedFile === f.path ? 'is-selected' : ''}"
                                      title=${f.path}
                                      @click=${() => {
                                          state.selectedFile = f.path;
                                          void loadPatch(context, state);
                                      }}
                                  >
                                      <span class="jj-status jj-status-${f.status}">${f.status}</span>${f.path}
                                  </button>`,
                          )}
                      </div>`
            }
            <pre class="jj-patch">${renderPatch(state.patch ?? '', html)}</pre>
        </section>
    `;
}

function renderPatch(patch: string, html: Html) {
    if (patch === '') return html`<span class="jj-muted">(no changes)</span>`;
    return patch.split('\n').map((line) => {
        const cls =
            line.startsWith('+++') || line.startsWith('---')
                ? 'meta'
                : line.startsWith('@@')
                  ? 'hunk'
                  : line.startsWith('diff ') ||
                      line.startsWith('index ') ||
                      line.startsWith('new file') ||
                      line.startsWith('deleted file') ||
                      line.startsWith('rename ') ||
                      line.startsWith('similarity ')
                    ? 'meta'
                    : line.startsWith('+')
                      ? 'add'
                      : line.startsWith('-')
                        ? 'del'
                        : '';
        return html`<span class="jj-line ${cls}">${line} </span>`;
    });
}

function renderOpLog(state: PanelState, html: Html) {
    const entries = state.oplog;
    if (entries === undefined) return html`<section class="jj-body jj-muted">Loading operation log…</section>`;
    return html`
        <section class="jj-oplog">
            ${entries.map(
                (op) =>
                    html` <div class="jj-op ${op.snapshot ? 'is-snapshot' : ''}">
                        <code class="jj-change">${op.id}</code>
                        <span class="jj-muted">${formatTime(op.time)}</span>
                        ${op.workspace !== '' && op.workspace !== 'default' ? html`<span class="jj-tag">${op.workspace}</span>` : ''}
                        <span class="jj-desc">${op.description}</span>
                    </div>`,
            )}
            <p class="jj-muted jj-hint">Restore with <code>jj op restore &lt;id&gt;</code> in a terminal.</p>
        </section>
    `;
}

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------

function hasPeer(context: WorkspacePanelContext): boolean {
    return context.peer?.request !== undefined;
}

async function request(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
    if (context.peer?.request === undefined) throw new Error('The jj backend is unavailable');
    return context.peer.request(operation, input);
}

async function loadStatus(context: WorkspacePanelContext, options: { reloadDiff: boolean }): Promise<void> {
    const state = stateFor(context);
    if (!hasPeer(context)) return;
    state.statusLoading = true;
    state.error = undefined;
    context.host.requestRender();
    try {
        const result = await request(context, 'status', {});
        state.status = parseStatus(result);
        if (options.reloadDiff && state.diffTarget !== undefined) {
            await loadDiff(context, state.diffTarget, state.diffLabel ?? '');
        }
    } catch (error) {
        state.error = errorMessage(error);
    } finally {
        state.statusLoading = false;
        context.host.requestRender();
    }
}

async function loadDiff(context: WorkspacePanelContext, target: DiffTarget, label: string): Promise<void> {
    const state = stateFor(context);
    const sameTarget = JSON.stringify(state.diffTarget) === JSON.stringify(target);
    state.diffTarget = target;
    state.diffLabel = label;
    if (!sameTarget) state.selectedFile = undefined;
    state.diffLoading = true;
    state.error = undefined;
    context.host.requestRender();
    try {
        const [filesResult] = await Promise.all([
            request(context, 'files', target as unknown as JsonObject),
            loadPatch(context, state, false),
        ]);
        state.files = Array.isArray(filesResult)
            ? filesResult.flatMap((f) =>
                  isObject(f) ? [{ status: asString(f['status']), path: asString(f['path']) }] : [],
              )
            : [];
    } catch (error) {
        state.error = errorMessage(error);
    } finally {
        state.diffLoading = false;
        context.host.requestRender();
    }
}

async function loadPatch(context: WorkspacePanelContext, state: PanelState, render = true): Promise<void> {
    if (state.diffTarget === undefined) return;
    const input: JsonObject = {
        ...state.diffTarget,
        ...(state.selectedFile === undefined ? {} : { path: state.selectedFile }),
    };
    try {
        const result = await request(context, 'diff', input);
        state.patch = isObject(result) ? asString(result['patch']) : '';
        state.patchTruncated = isObject(result) && result['truncated'] === true;
    } catch (error) {
        state.error = errorMessage(error);
    }
    if (render) context.host.requestRender();
}

async function loadOpLog(context: WorkspacePanelContext): Promise<void> {
    const state = stateFor(context);
    state.view = 'oplog';
    context.host.requestRender();
    try {
        const result = await request(context, 'oplog', { limit: 30 });
        state.oplog = Array.isArray(result)
            ? result.flatMap((op) =>
                  isObject(op)
                      ? [
                            {
                                id: asString(op['id']),
                                description: asString(op['description']),
                                time: asString(op['time']),
                                snapshot: op['snapshot'] === true,
                                workspace: asString(op['workspace']),
                            },
                        ]
                      : [],
              )
            : [];
    } catch (error) {
        state.error = errorMessage(error);
    }
    context.host.requestRender();
}

async function runBusy(
    context: WorkspacePanelContext,
    message: string,
    operation: string,
    input: JsonValue,
): Promise<void> {
    const state = stateFor(context);
    state.busy = message;
    state.error = undefined;
    context.host.requestRender();
    try {
        await request(context, operation, input);
        await loadStatus(context, { reloadDiff: true });
    } catch (error) {
        state.error = errorMessage(error);
    } finally {
        state.busy = undefined;
        context.host.requestRender();
    }
}

async function runPull(context: WorkspacePanelContext): Promise<void> {
    const state = stateFor(context);
    state.busy = 'Running jj pull in the terminal…';
    state.error = undefined;
    context.host.requestRender();
    try {
        const handle = await context.terminal.runCommand({
            title: 'jj pull',
            command: 'jj pull',
            metadata: { plugin: 'jj', operation: 'pull' },
            open: true,
        });
        const run = await handle.completed;
        if (run.exitCode !== undefined && run.exitCode !== 0) {
            state.error = `jj pull exited with code ${String(run.exitCode)} — see the terminal.`;
        }
    } catch (error) {
        state.error = errorMessage(error);
    } finally {
        state.busy = undefined;
    }
    await loadStatus(context, { reloadDiff: true });
    const conflicts = state.status?.conflicts ?? [];
    if (conflicts.length > 0) {
        state.error = undefined;
        context.host.requestRender();
    }
}

function pullResolvePrompt(workspacePath: string, conflicts: string[] | undefined): string {
    const target =
        conflicts === undefined || conflicts.length === 0
            ? 'Run `jj pull`, then check for and resolve any conflicts.'
            : `\`jj pull\` was already run; these changes are conflicted: ${conflicts.join(', ')}. Resolve them.`;
    return `Use the jj-pull skill in ${workspacePath}. ${target} Do not push.\n`;
}

async function addWorkspaceFromPrompt(runtime: PluginRuntimeContext, qualifiedPanelId: string): Promise<void> {
    const workspace = runtime.state.selectedWorkspace;
    if (workspace === undefined) return;
    const name = window.prompt('New jj workspace name (letters, digits, . _ -):')?.trim();
    if (name === undefined || name === '') return;
    const revision = window.prompt('Parent revision (blank = same parents as @):', '')?.trim();
    runtime.selectWorkspaceTool(qualifiedPanelId);
    // Route through the panel so the backend request, progress and errors show there.
    const panelContext = lastPanelContext.get(workspace.id);
    if (panelContext === undefined) {
        window.alert('The jj panel is opening; run this action again once it is visible.');
        return;
    }
    const state = stateFor(panelContext);
    const input: JsonObject = { name, ...(revision === undefined || revision === '' ? {} : { revision }) };
    state.busy = `Creating workspace ${name}…`;
    panelContext.host.requestRender();
    try {
        const result = await request(panelContext, 'workspace.add', input);
        const path = isObject(result) ? asString(result['path']) : '';
        await runtime.refreshAppData();
        state.error = undefined;
        state.busy = undefined;
        panelContext.host.requestRender();
        window.alert(`Created jj workspace "${name}" at ${path}`);
    } catch (error) {
        state.busy = undefined;
        state.error = errorMessage(error);
        panelContext.host.requestRender();
    }
}

const lastPanelContext = new Map<string, WorkspacePanelContext>();

function insertDiffContext(context: WorkspacePanelContext, state: PanelState): void {
    const files = (state.files ?? []).map((f) => `- ${f.status} ${f.path}`).join('\n');
    const text = `jj diff ${state.diffLabel ?? ''} in ${context.workspace.label}:\n${files}\n`;
    context.prompt.insertText(text);
}

// ---------------------------------------------------------------------------
// Parsing / utils
// ---------------------------------------------------------------------------

function parseStatus(value: JsonValue): Status {
    if (!isObject(value)) throw new Error('Invalid status response');
    const stack = Array.isArray(value['stack'])
        ? value['stack'].flatMap((c) => (isObject(c) ? [parseCommit(c)] : []))
        : [];
    return {
        workspace: asString(value['workspace']),
        where: isObject(value['where']) ? parseCommit(value['where']) : null,
        stack,
        conflicts: Array.isArray(value['conflicts'])
            ? value['conflicts'].flatMap((c) => (isObject(c) ? [parseCommit(c)] : []))
            : [],
        staleWorkspaces: Array.isArray(value['staleWorkspaces'])
            ? value['staleWorkspaces'].filter((s): s is string => typeof s === 'string')
            : [],
    };
}

function parseCommit(c: JsonObject): Commit {
    return {
        change: asString(c['change']),
        changePrefix: typeof c['changePrefix'] === 'number' ? c['changePrefix'] : 0,
        commit: asString(c['commit']),
        description: asString(c['description']),
        bookmarks: Array.isArray(c['bookmarks'])
            ? c['bookmarks'].filter((b): b is string => typeof b === 'string')
            : [],
        isWorkingCopy: c['isWorkingCopy'] === true,
        conflict: c['conflict'] === true,
        empty: c['empty'] === true,
        immutable: c['immutable'] === true,
        author: asString(c['author']),
        timestamp: asString(c['timestamp']),
    };
}

function metaString(meta: JsonObject | undefined, key: string): string {
    const v = meta?.[key];
    return typeof v === 'string' ? v : '';
}

function metaStringList(meta: JsonObject | undefined, key: string): string[] {
    const v = meta?.[key];
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diff = Math.round((now - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return d.toLocaleDateString();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Styles (mirrors the bundled Git panel's tokens)
// ---------------------------------------------------------------------------

const panelStyles = `
  .jj-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .jj-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 7px; cursor: pointer; font: inherit; }
  .jj-panel button:disabled { opacity: .5; cursor: default; }
  .jj-panel button.jj-link { border: 0; background: transparent; color: var(--pi-accent); padding: 0 4px; }
  .jj-panel code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .jj-muted { color: var(--pi-muted); }
  .jj-spacer { flex: 1 1 auto; }
  .jj-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .jj-toggle { display: inline-flex; }
  .jj-toggle button { border-radius: 0; margin-left: -1px; }
  .jj-toggle button:first-child { border-radius: 7px 0 0 7px; margin-left: 0; }
  .jj-toggle button:last-child { border-radius: 0 7px 7px 0; }
  .jj-toggle button.is-selected { position: relative; z-index: 1; border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .jj-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; white-space: pre-wrap; }
  .jj-notice { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-border); border-radius: 7px; color: var(--pi-muted); padding: 6px 8px; }
  .jj-conflicts { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; padding: 6px 8px; color: var(--pi-danger); }
  .jj-conflicts code { color: var(--pi-text); }
  .jj-body { padding: 10px; }
  .jj-where { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .jj-change b { color: var(--pi-accent); font-weight: 700; }
  .jj-bookmark { border: 1px solid var(--pi-accent); border-radius: 999px; color: var(--pi-accent); padding: 0 6px; font-size: 11px; }
  .jj-tag { border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 6px; font-size: 11px; }
  .jj-conflict { border: 1px solid var(--pi-danger); border-radius: 999px; color: var(--pi-danger); padding: 0 6px; font-size: 11px; }
  .jj-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; text-align: left; }
  .jj-stack { flex: 0 0 auto; max-height: 40%; overflow: auto; padding: 6px; border-bottom: 1px solid var(--pi-border); }
  .jj-row { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px; }
  .jj-row:hover, .jj-row.is-selected { background: var(--pi-selection-bg); }
  .jj-row.is-immutable { opacity: .75; }
  .jj-glyph { width: 1.2em; text-align: center; color: var(--pi-dim, var(--pi-muted)); font-family: ui-monospace, monospace; }
  .jj-stale { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--pi-warning-border); color: var(--pi-warning); }
  .jj-diff { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .jj-diff-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .jj-diff-header > span:first-child { flex: 1 1 auto; }
  .jj-files { flex: 0 0 auto; max-height: 30%; overflow: auto; padding: 4px 6px; border-bottom: 1px solid var(--pi-border-muted); }
  .jj-file { display: flex; gap: 6px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 2px 6px; font: 12px ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jj-file:hover, .jj-file.is-selected { background: var(--pi-selection-bg); }
  .jj-status { width: 1.2em; color: var(--pi-muted); }
  .jj-status-A { color: var(--pi-success, #3fb950); } .jj-status-D { color: var(--pi-danger); } .jj-status-M { color: var(--pi-warning, #d29922); }
  .jj-patch { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0; padding: 8px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.4; }
  .jj-line { display: block; white-space: pre; }
  .jj-line.add { background: color-mix(in srgb, var(--pi-success, #3fb950) 14%, transparent); }
  .jj-line.del { background: color-mix(in srgb, var(--pi-danger) 14%, transparent); }
  .jj-line.hunk { color: var(--pi-accent); background: color-mix(in srgb, var(--pi-accent) 9%, transparent); }
  .jj-line.meta { color: var(--pi-dim, var(--pi-muted)); }
  .jj-oplog { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px; }
  .jj-op { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 5px; }
  .jj-op:hover { background: var(--pi-selection-bg); }
  .jj-op.is-snapshot { opacity: .6; }
  .jj-hint { padding: 8px 6px; }
`;
