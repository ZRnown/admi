export interface DispatchRetryMeta {
  attempt: number;
  maxRetries: number;
  lastError?: string;
}

export interface DispatchUpload {
  url?: string;
  localPath?: string;
  filename: string;
  isImage?: boolean;
  isVideo?: boolean;
}

export interface DispatchPayload {
  content: string;
  sourceMessageId?: string;
  replyToSourceMessageId?: string;
  replyToTarget?: { channelId: string; messageId: string };
  username?: string;
  avatarUrl?: string;
  useEmbed?: boolean;
  extraEmbeds?: any[];
  uploads?: DispatchUpload[];
  components?: any[];
  enableTranslationOverride?: boolean;
  translationDirection?: "auto" | "zh-en" | "en-zh" | "off";
  ruleReplacementsDictionary?: Record<string, string>;
  stripEnglish?: boolean;
  stripChinese?: boolean;
  watermark?: any;
  watermarkSecondary?: any;
  watermarks?: any[];
}

export type DispatchTarget =
  | {
      kind: "webhook";
      webhookUrl: string;
      targetLabel: string;
    }
  | {
      kind: "channel" | "friend";
      accountId: string;
      targetId: string;
      targetLabel: string;
    };

export interface ForwardDispatchJob {
  id: string;
  instanceId: string;
  sourceMessageId: string;
  routeId: string;
  dedupeKey: string;
  createdAt: number;
  retryMeta: DispatchRetryMeta;
  target: DispatchTarget;
  payload: DispatchPayload;
  context: {
    sourceChannelId: string;
    logPrefix: string;
    senderIndex: number;
    routeCount: number;
  };
}

export interface DispatchEnqueueResult {
  shardId: number;
  queueKey: string;
}

export type DispatchEnqueueHandler = (job: ForwardDispatchJob) => Promise<DispatchEnqueueResult>;

export interface StandbyActivityStore {
  markActivity(channelId: string, atMs?: number): Promise<void>;
  hasActivitySince(channelId: string, sinceMs: number): Promise<boolean>;
}
