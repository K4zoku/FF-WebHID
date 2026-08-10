export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error(msg)), ms)
  return Promise.race([p, promise]).finally(() => clearTimeout(timer))
}
