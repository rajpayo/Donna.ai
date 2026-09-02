/** Cosine similarity for bucket-centroid matching. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Fold a new member embedding into a running centroid (mean, renormalized by usage at query time). */
export function updatedCentroid(
  centroid: number[],
  itemCount: number,
  newEmbedding: number[],
): number[] {
  if (centroid.length !== newEmbedding.length) return newEmbedding;
  return centroid.map(
    (c, i) => (c * itemCount + newEmbedding[i]!) / (itemCount + 1),
  );
}
