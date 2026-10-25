export function isDev(env: { ENV: string }): boolean {
  return `${env.ENV}` === "dev";
}
