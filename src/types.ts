export interface BotStatus {
  status: string;
  dbStatus: string;
  adminConfigured: boolean;
  queueSize: number;
  nextTaskIn: number;
  isQueuePaused?: boolean;
  activeJobs?: Array<{
    link: string;
    phase: string;
    progress?: {
      percent: number;
      current: number;
      total: number;
      speed: string;
      elapsed: string;
      eta: string;
    } | null;
    cooldownRemaining?: number;
    isMirror?: boolean;
  }>;
  batches?: Array<{
    batchId: string;
    total: number;
    processed: number;
    success: number;
    failed: number;
    currentLink?: string;
    startTime: number;
    progress: number;
    isActive: boolean;
  }>;
  taskQueue?: Array<{
    link: string;
    isMirror?: boolean;
    userId?: number;
  }>;
  proxy?: {
    ip: string;
    port: number;
    user?: string;
    pass?: string;
    socksType?: 4 | 5;
  } | null;
  botInfo: {
    id: number;
    first_name: string;
    username: string;
  } | null;
  config: {
    hasToken: boolean;
    hasMongo: boolean;
    hasSession: boolean;
    hasTarget: boolean;
  };
  settings: {
    adminId: string | null;
    destinationChatId: string | null;
    apiId: string | null;
    apiHash: string | null;
    downloadLibrary: string | null;
    renameRules?: Array<{ keyword: string; replaceWith: string }>;
    cooldownSeconds?: number | string;
    mirrorPaths?: Array<{
      sourceId: string;
      destId: string;
      groupName: string;
      destThreadId?: string;
      destTopicName?: string;
    }>;
  };
}
