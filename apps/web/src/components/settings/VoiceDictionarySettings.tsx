import { useState } from "react";

import {
  applySubscriptionDictionaryPreset,
  DEFAULT_VOICE_SETTINGS,
  formatVoiceDictionaryText,
  parseVoiceDictionaryText,
  useVoiceSettings,
  VOICE_AUTO_STOP_OPTIONS,
  VOICE_DICTIONARY_MAX_ENTRIES,
  VOICE_MODES,
  VOICE_REALTIME_VOICES,
  VOICE_SUBSCRIPTION_LABELS,
  VOICE_SUBSCRIPTION_PROVIDERS,
  type T3VoiceMode,
} from "../chat/ComposerVoiceControls";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MODE_LABELS: Record<T3VoiceMode, string> = {
  dictation: "Dictation",
  "hands-free": "Hands-Free Loop",
  live: "Live Voice WebRTC (AVAS v3)",
};

function autoStopLabel(ms: number) {
  return ms === 0 ? "Off" : `${ms / 1000}s`;
}

function voiceLabel(voice: string) {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

export function VoiceDictionarySettings() {
  const serverSettings = useScopedSettings();
  const updateScopedSettings = useUpdateScopedSettings();
  const [settings, setSettings] = useVoiceSettings(serverSettings);
  const [dictionaryDraft, setDictionaryDraft] = useState<string | null>(null);
  const dictionaryText = dictionaryDraft ?? formatVoiceDictionaryText(settings.entries);

  const commitDictionary = () => {
    if (dictionaryDraft === null) return;
    const entries = parseVoiceDictionaryText(dictionaryDraft);
    setSettings((current) => ({ ...current, entries }));
    updateScopedSettings({
      voiceDictionary: { prompt: settings.prompt, entries },
    });
    setDictionaryDraft(null);
  };

  return (
    <SettingsSection id="voice-and-dictionary" title="Voice & Dictionary">
      <SettingsRow
        id="voice-subscription-provider"
        title="Subscription dictionary plan"
        description="Switch voice & dictionary presets between ChatGPT Subscription (Plus / Pro) and Grok Subscription (SuperGrok / X Premium+)."
        control={
          <Select
            value={settings.subscriptionProvider}
            onValueChange={(value) => {
              const provider = VOICE_SUBSCRIPTION_PROVIDERS.find((candidate) => candidate === value);
              if (!provider) return;
              const next = applySubscriptionDictionaryPreset(settings, provider);
              setSettings(next);
              setDictionaryDraft(null);
              updateScopedSettings({
                voiceSubscriptionProvider: next.subscriptionProvider,
                voiceDictionary: { prompt: next.prompt, entries: next.entries },
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-72"
              aria-label="Subscription dictionary plan"
            >
              <SelectValue>{VOICE_SUBSCRIPTION_LABELS[settings.subscriptionProvider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_SUBSCRIPTION_PROVIDERS.map((provider) => (
                <SelectItem hideIndicator key={provider} value={provider}>
                  {VOICE_SUBSCRIPTION_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="voice-mode"
        title="Default voice mode"
        description="What the composer mic does when you press it."
        control={
          <Select
            value={settings.mode}
            onValueChange={(value) => {
              const mode = VOICE_MODES.find((candidate) => candidate === value);
              if (mode) setSettings((current) => ({ ...current, mode }));
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Default voice mode">
              <SelectValue>{MODE_LABELS[settings.mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_MODES.map((mode) => (
                <SelectItem hideIndicator key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="voice-auto-stop"
        title="Stop after silence"
        description="Dictation and hands-free stop recording after this much quiet."
        resetAction={
          settings.autoStopMs !== DEFAULT_VOICE_SETTINGS.autoStopMs ? (
            <SettingResetButton
              label="silence timeout"
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  autoStopMs: DEFAULT_VOICE_SETTINGS.autoStopMs,
                }))
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.autoStopMs)}
            onValueChange={(value) => {
              const autoStopMs = VOICE_AUTO_STOP_OPTIONS.find((ms) => String(ms) === value);
              if (autoStopMs !== undefined) setSettings((current) => ({ ...current, autoStopMs }));
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Stop after silence">
              <SelectValue>{autoStopLabel(settings.autoStopMs)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_AUTO_STOP_OPTIONS.map((ms) => (
                <SelectItem hideIndicator key={ms} value={String(ms)}>
                  {autoStopLabel(ms)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="voice-realtime-voice"
        title="Live voice"
        description="The voice that answers in Live Voice mode."
        control={
          <Select
            value={settings.realtimeVoice}
            onValueChange={(value) => {
              const realtimeVoice = VOICE_REALTIME_VOICES.find((voice) => voice === value);
              if (realtimeVoice) {
                setSettings((current) => ({ ...current, realtimeVoice }));
                updateScopedSettings({ voiceRealtimeVoice: realtimeVoice });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Live voice">
              <SelectValue>{voiceLabel(settings.realtimeVoice)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_REALTIME_VOICES.map((voice) => (
                <SelectItem hideIndicator key={voice} value={voice}>
                  {voiceLabel(voice)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="voice-prompt"
        title="Project context"
        description="Short context that helps transcription spell names and jargon."
      >
        <Textarea
          className="mt-2"
          value={settings.prompt}
          placeholder="T3 Code desktop app, Effect, Electron, Hermes agents…"
          aria-label="Voice project context"
          onChange={(event) => {
            const prompt = event.currentTarget.value;
            setSettings((current) => ({ ...current, prompt }));
          }}
          onBlur={() =>
            updateScopedSettings({
              voiceDictionary: { prompt: settings.prompt, entries: settings.entries },
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        id="voice-dictionary"
        title="Dictionary"
        description={`One term per line, or "Term: alias1, alias2". Up to ${VOICE_DICTIONARY_MAX_ENTRIES} terms (${settings.entries.length} saved).`}
      >
        <Textarea
          className="mt-2"
          value={dictionaryText}
          placeholder={"T3 Code\nEffect: effect ts, effects\nHermes: hermez"}
          aria-label="Voice dictionary"
          onChange={(event) => setDictionaryDraft(event.currentTarget.value)}
          onBlur={commitDictionary}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
