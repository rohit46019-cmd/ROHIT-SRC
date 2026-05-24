export interface BotStatus {
  status: string;
  dbStatus: string;
  adminConfigured: boolean;
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
