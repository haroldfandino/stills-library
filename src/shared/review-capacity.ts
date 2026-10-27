/** Keep native work sequential and limit open human review workspaces. */
export function reviewCapacity(memoryBytes: number): number {
  return memoryBytes < 8 * 1024 ** 3 ? 1 : memoryBytes < 16 * 1024 ** 3 ? 2 : 3;
}
