import js from '@eslint/js'
import jsdoc from 'eslint-plugin-jsdoc'
import tseslint from 'typescript-eslint'

const browserTypes = [
  'Worker',
  'Window',
  'HTMLElement',
  'HTMLDialogElement',
  'HTMLSelectElement',
  'HTMLInputElement',
  'ShadowRoot',
  'Event',
  'EventListener',
  'EventListenerObject',
  'EventListenerOrEventListenerObject',
  'ErrorConstructor',
  'PropertyDescriptor',
  'TypedArray',
  'BufferSource',
  'Element',
  'Document',
  'MessageEvent',
  'setTimeout',
  'HTMLIFrameElement',
  'MutationObserver',
  'MutationRecord',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'Headers',
  'AbortSignal',
  'Node',
  'NodeList',
  'WebTransport',
  'WebTransportError',
  'WebTransportBidirectionalStream',
  'ReadableStream',
  'ReadableStreamDefaultReader',
  'WritableStreamDefaultWriter'
]

const testGlobals = {
  node: true,
  es2022: true,
  test: 'readonly',
  expect: 'readonly',
  describe: 'readonly',
  it: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly'
} as const

export default tseslint.config(
  {
    files: ['addon/js/**/*.js', 'addon/js/pages/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'script',
      globals: {
        webhid: 'readonly',
        browser: 'readonly',
        chrome: 'readonly',
        self: 'readonly',
        globalThis: 'readonly',
        document: 'readonly',
        window: 'readonly',
        Window: 'readonly',
        Worker: 'readonly',
        Navigator: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        EventListener: 'readonly',
        CustomEvent: 'readonly',
        MessageEvent: 'readonly',
        DOMParser: 'readonly',
        DOMException: 'readonly',
        MessageChannel: 'readonly',
        MessagePort: 'readonly',
        WebSocket: 'readonly',
        WebTransport: 'readonly',
        WebTransportError: 'readonly',
        Uint8Array: 'readonly',
        ArrayBuffer: 'readonly',
        DataView: 'readonly',
        Blob: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        MutationObserver: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        trustedTypes: 'readonly',
        TrustedTypePolicy: 'readonly',
        Node: 'readonly',
        NodeList: 'readonly',
        AbortSignal: 'readonly',
        Headers: 'readonly',
        IDBKeyRange: 'readonly',
        indexedDB: 'readonly',
        Text: 'readonly',
        Comment: 'readonly',
        performance: 'readonly',
        importScripts: 'readonly',
        postMessage: 'readonly',
        close: 'readonly',
        onmessage: 'readonly',
        onerror: 'readonly',
        global: 'readonly'
      }
    },
    plugins: { jsdoc },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false
          }
        }
      ],
      'jsdoc/require-param': 'warn',
      'jsdoc/require-returns': 'warn',
      'jsdoc/require-param-type': 'warn',
      'jsdoc/require-returns-type': 'warn',
      'jsdoc/check-types': 'warn',
      'jsdoc/no-undefined-types': ['warn', { definedTypes: browserTypes }],
      'jsdoc/require-param-name': 'warn',
      'jsdoc/valid-types': 'warn'
    }
  },
  {
    files: ['tests/**/*.ts'],
    extends: [...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: 'tests/tsconfig.json'
      },
      globals: testGlobals
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['eslint.config.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        node: true
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
)
