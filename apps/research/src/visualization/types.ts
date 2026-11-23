/** Browser-side artifact contracts used by the standalone MLCC preview island. */
export type ServerAgentArtifactReference = Readonly<{
  runId: string
  sequence: number
  name: string
  mimeType: string
}>
