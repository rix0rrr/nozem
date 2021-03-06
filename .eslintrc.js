/**
 * JavaScript and generic rules:
 *
 *     https://eslint.org/docs/rules/
 *
 * TypeScript-specific rules (including migrations from TSlint), see here:
 *
 *     https://github.com/typescript-eslint/typescript-eslint/blob/master/packages/eslint-plugin/ROADMAP.md
 */
module.exports = {
  env: {
    jest: true,
    node: true,
  },
  plugins: [
    '@typescript-eslint',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: '2018',
    sourceType: 'module',
    project: './tsconfig.json',
  },
  extends: [],
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
    'import/resolver': {
      node: {},
      typescript: {
        directory: './tsconfig.json',
      },
    },
  },
  ignorePatterns: ['*.js', '*.d.ts', 'node_modules/', '*.generated.ts'],
  rules: {
    // Require use of the `import { foo } from 'bar';` form instead of `import foo = require('bar');`
    '@typescript-eslint/no-require-imports': ['error'],

    // Style
    'comma-spacing': ['error', { before: false, after: true }], // space after, no space before
    'array-bracket-spacing': ['error', 'never'], // [1, 2, 3]
    'array-bracket-newline': ['error', 'consistent'], // enforce consistent line breaks between brackets
    'object-curly-spacing': ['error', 'always'], // { key: 'value' }
    'object-curly-newline': ['error', { multiline: true, consistent: true }], // enforce consistent line breaks between braces
    'object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }], // enforce "same line" or "multiple line" on object properties
    'keyword-spacing': ['error'], // require a space before & after keywords
    'space-before-blocks': 'error', // require space before blocks
    'curly': ['error', 'multi-line', 'consistent'], // require curly braces for multiline control statements

    // Cannot shadow names
    'no-shadow': ['off'],
    '@typescript-eslint/no-shadow': ['error'],

    // Required spacing in property declarations (copied from TSLint, defaults are good)
    'key-spacing': ['error'],

    // Require semicolons
    'semi': ['error', 'always'],

    // Don't unnecessarily quote properties
    'quote-props': ['error', 'consistent-as-needed'],

    // No multiple empty lines
    'no-multiple-empty-lines': ['error'],

    // Max line lengths
    'max-len': ['error', {
      code: 150,
      ignoreUrls: true, // Most common reason to disable it
      ignoreStrings: true, // These are not fantastic but necessary for error messages
      ignoreTemplateLiterals: true,
      ignoreComments: true,
      ignoreRegExpLiterals: true,
    }],

    // One of the easiest mistakes to make
    '@typescript-eslint/no-floating-promises': ['error'],

    // Make sure that inside try/catch blocks, promises are 'return await'ed
    // (must disable the base rule as it can report incorrect errors)
    'no-return-await': 'off',
    '@typescript-eslint/return-await': 'error',

    // Don't leave log statements littering the premises!
    'no-console': ['error'],

    // Useless diff results
    'no-trailing-spaces': ['error'],

    // Must use foo.bar instead of foo['bar'] if possible
    'dot-notation': ['error'],

    // Must use 'import' statements (disabled because it doesn't add a lot over no-require-imports)
    // '@typescript-eslint/no-var-requires': ['error'],

    // Are you sure | is not a typo for || ?
    'no-bitwise': ['error'],

    // Oh ho ho naming. Everyone's favorite topic!
    // FIXME: there's no way to do this properly. The proposed tslint replacement
    // works very differently, also checking names in object literals, which we use all over the
    // place for configs, mockfs, nodeunit tests, etc.
    //
    // The maintainer does not want to change behavior.
    // https://github.com/typescript-eslint/typescript-eslint/issues/1483
    //
    // There is no good replacement for tslint's name checking, currently. We will have to make do
    // with jsii's validation.
    /*
    '@typescript-eslint/naming-convention': ['error',

      // We could maybe be more specific in a number of these but I didn't want to
      // spend too much effort. Knock yourself out if you feel like it.
      { selector: 'enumMember', format: ['PascalCase', 'UPPER_CASE'] },
      { selector: 'variableLike', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
      { selector: 'typeLike', format: ['PascalCase'], leadingUnderscore: 'allow' },
      { selector: 'memberLike', format: ['camelCase', 'PascalCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },

      // FIXME: there's no way to disable name checking in object literals. Maintainer won't have it
      // https://github.com/typescript-eslint/typescript-eslint/issues/1483
    ],
    */

    // Member ordering
    '@typescript-eslint/member-ordering': ['error', {
      default: [
        'public-static-field',
        'public-static-method',
        'protected-static-field',
        'protected-static-method',
        'private-static-field',
        'private-static-method',

        'field',

        // Constructors
        'constructor', // = ["public-constructor", "protected-constructor", "private-constructor"]

        // Methods
        'method',
      ],
    }],
  },
};

