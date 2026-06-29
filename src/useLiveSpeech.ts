import { useCallback, useEffect, useRef, useState } from "react";

export interface LiveCaptionSegment {
  time: string;
  text: string;
}

function speechRecognitionCtor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** Live speech-to-text while recording (online; final pass still uses Whisper). */
export function useLiveSpeech(active: boolean, getTime: () => string) {
  const [segments, setSegments] = useState<LiveCaptionSegment[]>([]);
  const [interim, setInterim] = useState("");
  const [supported] = useState(() => speechRecognitionCtor() !== null);
  const [speechError, setSpeechError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(active);
  const getTimeRef = useRef(getTime);

  activeRef.current = active;
  getTimeRef.current = getTime;

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    rec?.stop();
    setInterim("");
  }, []);

  const startRecognition = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;

    setSegments([]);
    setInterim("");
    setSpeechError(null);

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        if (result.isFinal) {
          setSegments((prev) => [...prev, { time: getTimeRef.current(), text }]);
        } else {
          pending += result[0].transcript;
        }
      }
      setInterim(pending.trim());
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setSpeechError(`Live captions paused (${event.error})`);
    };

    rec.onend = () => {
      if (!activeRef.current || recognitionRef.current !== rec) return;
      try {
        rec.start();
      } catch {
        /* already running */
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      setSpeechError("Could not start live captions");
    }
  }, []);

  useEffect(() => {
    if (active && supported) {
      startRecognition();
      return stopRecognition;
    }
    stopRecognition();
    return undefined;
  }, [active, supported, startRecognition, stopRecognition]);

  useEffect(() => {
    if (!active) {
      setInterim("");
    }
  }, [active]);

  return { segments, interim, supported, speechError, clear: () => setSegments([]) };
}
