declare module 'js-yaml' {
  export const JSON_SCHEMA: unknown
  export function load(source: string, options?: { schema?: unknown }): unknown
}
