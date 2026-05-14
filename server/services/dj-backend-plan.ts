export interface DjBackendAssessment {
  recommended: 'gstreamer';
  alternatives: string[];
  rationale: string[];
  nextSteps: string[];
}

export function getDjBackendAssessment(): DjBackendAssessment {
  return {
    recommended: 'gstreamer',
    alternatives: ['mpv', 'custom ffmpeg pipeline'],
    rationale: [
      'GStreamer is already installed on the host.',
      'Audio sinks for PulseAudio and PipeWire are available.',
      'It supports robust local media playback pipelines and future DSP growth.',
      'It is better aligned with a daemon-style local playback engine than browser WebAudio.',
    ],
    nextSteps: [
      'Implement a dedicated local playback worker using GStreamer.',
      'Route queue/transport commands from dj-local-engine into that worker.',
      'Expose playback progress and lifecycle events back to /api/dj-local-engine/state.',
      'Eventually migrate crossfade logic from scaffold state into real local playback transitions.',
    ],
  };
}
