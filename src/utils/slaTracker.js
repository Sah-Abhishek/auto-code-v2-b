/**
 * SLA Tracker - Tracks processing times across pipeline stages
 */
export class SLATracker {
  constructor() {
    this.timestamps = {
      uploadReceived: null,
      ocrStarted: null,
      ocrCompleted: null,
      aiStarted: null,
      aiCompleted: null,
      processingComplete: null
    };
  }

  markUploadReceived() {
    this.timestamps.uploadReceived = Date.now();
    return this;
  }

  markOCRStarted() {
    this.timestamps.ocrStarted = Date.now();
    return this;
  }

  markOCRCompleted() {
    this.timestamps.ocrCompleted = Date.now();
    return this;
  }

  markAIStarted() {
    this.timestamps.aiStarted = Date.now();
    return this;
  }

  markAICompleted() {
    this.timestamps.aiCompleted = Date.now();
    return this;
  }

  markComplete() {
    this.timestamps.processingComplete = Date.now();
    return this;
  }

  getSummary() {
    const {
      uploadReceived,
      ocrStarted,
      ocrCompleted,
      aiStarted,
      aiCompleted,
      processingComplete
    } = this.timestamps;

    const totalTime = processingComplete - uploadReceived;
    const ocrTime = ocrCompleted - ocrStarted;
    const aiTime = aiCompleted - aiStarted;
    const overheadTime = totalTime - ocrTime - aiTime;

    return {
      timestamps: {
        uploadReceived: new Date(uploadReceived).toISOString(),
        ocrStarted: new Date(ocrStarted).toISOString(),
        ocrCompleted: new Date(ocrCompleted).toISOString(),
        aiStarted: new Date(aiStarted).toISOString(),
        aiCompleted: new Date(aiCompleted).toISOString(),
        processingComplete: new Date(processingComplete).toISOString()
      },
      durations: {
        total: `${totalTime}ms`,
        ocr: `${ocrTime}ms`,
        ai: `${aiTime}ms`,
        overhead: `${overheadTime}ms`
      },
      durations_ms: {
        total: totalTime,
        ocr: ocrTime,
        ai: aiTime,
        overhead: overheadTime
      },
      slaStatus: this.calculateSLAStatus(totalTime)
    };
  }

  calculateSLAStatus(totalTimeMs) {
    const SLA_EXCELLENT = 30000;
    const SLA_GOOD = 60000;
    const SLA_ACCEPTABLE = 120000;

    if (totalTimeMs < SLA_EXCELLENT) {
      return { status: 'excellent', message: 'Processed within 30 seconds' };
    } else if (totalTimeMs < SLA_GOOD) {
      return { status: 'good', message: 'Processed within 1 minute' };
    } else if (totalTimeMs < SLA_ACCEPTABLE) {
      return { status: 'acceptable', message: 'Processed within 2 minutes' };
    } else {
      return { status: 'delayed', message: 'Processing exceeded 2 minutes' };
    }
  }
}

export const createSLATracker = () => new SLATracker();

/**
 * Calculate SLA hours since completion
 */
export function calculateSLAHours(completedAt) {
  if (!completedAt) return null;

  const completed = new Date(completedAt);
  const now = new Date();
  const diffMs = now - completed;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  return {
    hours: diffHours,
    isWarning: diffHours >= 24,
    isCritical: diffHours >= 48
  };
}
