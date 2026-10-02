# odtuclass-sync
Sync your odtuclass with a github actions automation.

## Local sync

The sync command reads credentials from environment variables and never logs or
writes the password. State is stored in `.odtuclass/state.json` by default;
set `ODTUCLASS_STATE_PATH` to override it.

Linux/macOS:

```sh
ODTU_USERNAME='your-username' ODTU_PASSWORD='your-password' npm run sync
```

Windows PowerShell:

```powershell
$env:ODTU_USERNAME = 'your-username'
$env:ODTU_PASSWORD = 'your-password'
npm run sync
```
