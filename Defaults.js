.pragma library

// Default settings, shared by the sync service (Service.qml) and its bar
// icon (Settings.qml). A setting that is missing from shell.json uses these.
var values = {
  // https://github.com/<owner>/<repo>, created by the user.
  // The vaults ticked for each repository are kept by the service in
  // ~/.config/vault-sync/repos.json, not here.
  repoUrl: ""
}
