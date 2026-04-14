declare module 'mailparser' {
  export function simpleParser(input: string): Promise<any>
}

declare module 'html-to-text' {
  export function convert(
    html: string,
    options?: Record<string, unknown>,
  ): string
}
