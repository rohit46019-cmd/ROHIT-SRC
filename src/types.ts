export interface BotStatus {
  status: string;
  dbStatus: string;
  adminConfigured: boolean;
  queueSize: number;
  nextTaskIn: number;
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
  };
  settings: {
    adminId: string | null;
    stringSession: string | null;
    downloadLibrary: string | null;
    renameRules?: Array<{ keyword: string; replaceWith: string }>;
  };
}
