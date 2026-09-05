const PREFIX = '[media]';

function fmt(level: string, message: string): string {
  return `${PREFIX} ${new Date().toISOString()} ${level} ${message}`;
}

export const Logger = {
  info(message: string): void {
    console.log(fmt('INFO', message));
  },
  warn(message: string): void {
    console.warn(fmt('WARN', message));
  },
  error(message: string): void {
    console.error(fmt('ERROR', message));
  },
};
