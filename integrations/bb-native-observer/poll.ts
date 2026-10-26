export function poll<T>(read: () => Promise<T>, receive: (value: T) => void, failed: (error: unknown) => void, delay = 1000): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try { const value = await read(); if (!disposed) receive(value); }
    catch (error) { if (!disposed) failed(error); }
    if (!disposed) timer = setTimeout(() => void refresh(), delay);
  };
  void refresh();
  return () => { disposed = true; clearTimeout(timer); };
}
