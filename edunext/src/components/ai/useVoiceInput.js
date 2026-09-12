import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speech-to-text for the composer, on the Web Speech API.
 *
 * ---------------------------------------------------------------------------
 * THE SUPPORT STORY IS THE WHOLE STORY
 * ---------------------------------------------------------------------------
 *
 * `SpeechRecognition` is not a web standard anyone has shipped uniformly. It
 * exists prefixed in Chrome and Edge, exists in Safari, and DOES NOT EXIST in
 * Firefox at all. On Chrome it is not even local: audio goes to a Google
 * server for recognition.
 *
 * So this hook reports `supported` and the button renders disabled with a
 * reason when it is false. The alternative — a mic button that looks identical
 * everywhere and silently does nothing for a third of browsers — is worse than
 * not offering the feature, because the learner blames themselves or their
 * microphone rather than the page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSCRIPT IS APPENDED, NOT ASSIGNED
 * ---------------------------------------------------------------------------
 *
 * Recognition returns a growing list of results, and the naive handler sets the
 * draft to the latest chunk — which erases anything the learner typed before
 * pressing the mic, and erases earlier speech every time the engine finalises a
 * segment. `onTranscript` therefore receives only the text for the CURRENT
 * utterance plus a flag saying whether it is final, and the caller decides how
 * to merge it with what is already in the box.
 */
export function useVoiceInput({ lang = 'ar', onTranscript }) {
  const Recognition =
    typeof window === 'undefined'
      ? undefined
      : (window.SpeechRecognition ?? window.webkitSpeechRecognition);

  const supported = Boolean(Recognition);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);

  const recognitionRef = useRef(null);
  /*
   * The handler is read through a ref rather than captured, because
   * `SpeechRecognition` holds whatever callback it was given at `start()` for
   * the life of the utterance. Capturing the prop would pin the first render's
   * closure and append into a stale draft.
   */
  const handlerRef = useRef(onTranscript);
  useEffect(() => {
    handlerRef.current = onTranscript;
  });

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!supported || recognitionRef.current) return;

    setError(null);
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    // One utterance per press: a continuous stream with no visible stop is a
    // hot microphone the learner forgets about.
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let text = '';
      let final = false;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        text += result[0].transcript;
        if (result.isFinal) final = true;
      }
      handlerRef.current?.(text, final);
    };

    recognition.onerror = (event) => {
      // `no-speech` and `aborted` are ordinary outcomes, not failures to report.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'لم يُسمح باستخدام الميكروفون. فعّلي الإذن من إعدادات المتصفح.'
          : 'تعذّر التقاط الصوت. حاولي مرة أخرى.',
      );
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      // `start()` throws if called twice; the ref guard above makes that rare,
      // but a rejected start must not leave the button stuck in "listening".
      recognitionRef.current = null;
      setListening(false);
    }
  }, [Recognition, lang, supported]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  /* A live microphone must not outlive the panel that opened it. */
  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return { supported, listening, error, toggle, stop, clearError: () => setError(null) };
}
