// Bun extends fs/promises with an `exists` function not in standard Node types
declare module "fs/promises" {
  function exists(path: string): Promise<boolean>
}
