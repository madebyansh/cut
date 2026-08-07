declare module "bidi-js" {
  type EmbeddingLevels = Readonly<{
    levels: Uint8Array;
    paragraphs: readonly Readonly<{ start: number; end: number; level: number }>[];
  }>;

  type BidiApi = Readonly<{
    getEmbeddingLevels(text: string, direction: "ltr" | "rtl"): EmbeddingLevels;
    getReorderSegments(
      text: string,
      embedding: EmbeddingLevels,
      start?: number,
      end?: number,
    ): readonly (readonly [number, number])[];
    getMirroredCharactersMap(
      text: string,
      embedding: EmbeddingLevels,
      start?: number,
      end?: number,
    ): ReadonlyMap<number, string>;
  }>;

  const bidiFactory: () => BidiApi;
  export default bidiFactory;
}
