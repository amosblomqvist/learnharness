export const SENSITIVE_HOME_PATHS: readonly string[];
export function comparisonPath(absolute: string): string;
export function isWithin(absolute: string, root: string, ignoreCase?: boolean): boolean;
export function credentialFiles(authFile: string): string[];
export function isCredentialTemp(absolute: string, directory: string, authBasename: string): boolean;
export function isSensitivePath(absolute: string, home: string, authFile?: string): boolean;
