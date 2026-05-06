'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

// TypeScript declarations for Web Speech API (not in standard lib)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionAny = any

export type VoiceInputState = {
  isListening: boolean
  isSupported: boolean
  transcript: string
  interimTranscript: string
  error: string | null
  startListening: () => void
  stopListening: () => void
  resetTranscript: () => void
}

const SILENCE_TIMEOUT_MS = 10_000

export function useVoiceInput(): VoiceInputState {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)

  // QA fix: use useState + useEffect to avoid SSR hydration mismatch.
  // During SSR window is undefined so an inline typeof check returns false,
  // but on the client it would be true — causing a React hydration warning.
  const [isSupported, setIsSupported] = useState(false)
  useEffect(() => {
    setIsSupported(
      !!(
        (window as SpeechRecognitionAny).SpeechRecognition ||
        (window as SpeechRecognitionAny).webkitSpeechRecognition
      )
    )
  }, [])

  const recognitionRef = useRef<SpeechRecognitionAny | null>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  const stopListening = useCallback(() => {
    clearSilenceTimer()
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
    setInterimTranscript('')
  }, [clearSilenceTimer])

  const startListening = useCallback(() => {
    if (!isSupported) return
    if (isListening) {
      stopListening()
      return
    }

    setError(null)
    setTranscript('')
    setInterimTranscript('')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition: SpeechRecognitionAny =
      (window as SpeechRecognitionAny).SpeechRecognition ||
      (window as SpeechRecognitionAny).webkitSpeechRecognition

    const recognition: SpeechRecognitionAny = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onstart = () => {
      setIsListening(true)
      // Auto-stop after SILENCE_TIMEOUT_MS
      silenceTimerRef.current = setTimeout(() => {
        recognition.stop()
      }, SILENCE_TIMEOUT_MS)
    }

    recognition.onresult = (event: SpeechRecognitionAny) => {
      // Reset silence timer on any speech activity
      clearSilenceTimer()
      silenceTimerRef.current = setTimeout(() => {
        recognition.stop()
      }, SILENCE_TIMEOUT_MS)

      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      if (final) {
        setTranscript((prev) => prev + final)
        setInterimTranscript('')
      } else {
        setInterimTranscript(interim)
      }
    }

    recognition.onerror = (event: SpeechRecognitionAny) => {
      clearSilenceTimer()
      setIsListening(false)
      setInterimTranscript('')

      if (event.error === 'not-allowed') {
        setError('Microphone access denied. Check browser permissions.')
      } else if (event.error === 'no-speech') {
        // Silent stop — not a user-facing error
        setError(null)
      } else if (event.error === 'network') {
        setError('Network error during voice recognition. Check your connection.')
      }
      // Other errors: silently stop
      recognitionRef.current = null
    }

    recognition.onend = () => {
      clearSilenceTimer()
      setIsListening(false)
      setInterimTranscript('')
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [isSupported, isListening, stopListening, clearSilenceTimer])

  const resetTranscript = useCallback(() => {
    setTranscript('')
    setInterimTranscript('')
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilenceTimer()
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
    }
  }, [clearSilenceTimer])

  return {
    isListening,
    isSupported,
    transcript,
    interimTranscript,
    error,
    startListening,
    stopListening,
    resetTranscript,
  }
}
