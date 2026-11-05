// WorkBuddy Cloud SDK 初始化（唯一客户端实例，全站共用）
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: window.PUBLIC_CONFIG.endpoint,
  oauthRelayBaseUrl: window.PUBLIC_CONFIG.oauthRelayBaseUrl,
  publishableKey: window.PUBLIC_CONFIG.publishableKey
});
