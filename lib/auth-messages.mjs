// Safe, fixed messages only. Provider responses and tokens never reach the browser.
export const authMessages={
 cancelled:'Google sign-in was cancelled. You can try again.',
 account:'That Google account cannot open this workspace. Choose your workspace account.',
 flow:'This sign-in attempt expired or opened in a different browser. Start again here and finish in this same browser.',
 client:'Google rejected the saved OAuth client. Check that its client ID and secret belong to the same Web application, then replace the local client configuration.',
 grant:'Google rejected the sign-in code. Start a fresh sign-in and finish it in this browser.',
 identity:'Google returned an identity token that could not be verified. Start a fresh sign-in; if it repeats, check this Mac’s date and time.',
 network:'Focus could not reach Google to finish sign-in. Check the connection and try again.',
 signin:'Google sign-in could not be completed. The failure stage was saved locally for troubleshooting.',
 expired:'Your session ended. Sign in again to continue.'
};
export const gmailMessages={
 gmail_api_disabled:'Signed in. Gmail access was granted, but the Gmail API is not enabled for your Google Cloud project. Enable it, then Refresh Gmail in Connections.',
 gmail_permission:'Signed in. Gmail is blocked by a permission or Workspace policy. Check the Google project settings, then reconnect Gmail in Connections.',
 gmail_refresh:'Signed in. Google did not provide background Gmail access. Reconnect Gmail in Connections and allow access.',
 gmail_network:'Signed in. Gmail could not be reached. Retry Refresh in Connections.',
 gmail_setup:'Signed in. Gmail setup did not finish. Open Connections to retry.'
};
export function gmailFailureCode(error){
 if(error.gmailCode&&gmailMessages[error.gmailCode])return error.gmailCode;
 if(['SERVICE_DISABLED','accessNotConfigured'].includes(error.providerReason))return 'gmail_api_disabled';
 if(error.status===401||error.status===403)return 'gmail_permission';
 if(error.name==='TypeError'||error.name==='TimeoutError'||error.name==='AbortError'||error.status>=500)return 'gmail_network';
 return 'gmail_setup';
}
export function signInFailureCode(error,stage){
 if(error.authCode&&authMessages[error.authCode])return error.authCode;
 if(stage==='state')return 'flow';
 if(['invalid_client','unauthorized_client'].includes(error.providerCode))return 'client';
 if(error.providerCode==='invalid_grant')return 'grant';
 if(error.name==='TypeError'||error.name==='TimeoutError'||error.name==='AbortError'||error.code==='ERR_JWKS_TIMEOUT')return 'network';
 if(stage==='identity')return 'identity';
 return 'signin';
}
