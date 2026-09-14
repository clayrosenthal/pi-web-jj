module.exports = [
    {
        languageOptions: {
            parser: require('@typescript-eslint/parser'),
            parserOptions: {
                project: ['tsconfig.json'],
            },
        },
        plugins: {
            '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
            prettier: require('prettier'),
        },
        files: ['src/**/*.ts'],
        ignores: ['*.tar.gz'],
        // For the list of rules supported by @typescript-eslint/eslint-plugin,
        // see: https://typescript-eslint.io/rules/
        rules: {},
    },
];
