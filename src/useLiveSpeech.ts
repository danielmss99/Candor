export interface LiveCaptionSegment {
  time: string;
  text: string;
}

/**
 * Browser live-caption APIs can send audio to cloud services depending on the
 * webview engine. Candor keeps live captions disabled until they use the same
 * local Whisper pipeline as saved transcripts.
 */
export function useLiveSpeech(_active: boolean, _getTime: () => string) {
  return {
    segments: [] as LiveCaptionSegment[],
    interim: "",
    supported: false,
    speechError: null as string | null,
    clear: () => {},
  };
}
