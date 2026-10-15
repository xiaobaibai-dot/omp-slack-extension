param(
  [Parameter(Mandatory=$true)][string]$TeamId,
  [Parameter(Mandatory=$true)][string]$AppId,
  [Parameter(Mandatory=$true)][string]$OwnerIds,
  [Parameter(Mandatory=$true)][string]$ChannelIds,
  [string]$ChannelAllUsers = ''
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$configPath = Join-Path $env:USERPROFILE '.omp\agent\slack-credentials.json'
$bot = Read-Host 'Bot Token (xoxb)' -AsSecureString
$app = Read-Host 'App Token (xapp)' -AsSecureString
try {
  $botText = [System.Net.NetworkCredential]::new('', $bot).Password
  $appText = [System.Net.NetworkCredential]::new('', $app).Password
  if ($botText -notmatch '^xoxb-\S+$' -or $appText -notmatch '^xapp-\S+$') {throw 'Token type is incorrect; no configuration saved.'}
  $values = @{
    OMP_SLACK_TEAM_ID=$TeamId; OMP_SLACK_APP_ID=$AppId
    OMP_SLACK_OWNER_IDS=$OwnerIds; OMP_SLACK_CHANNEL_IDS=$ChannelIds
    OMP_SLACK_CHANNEL_ALL_USERS=$ChannelAllUsers; OMP_SLACK_UPLOAD_MODE='host'
    OMP_SLACK_BOT_TOKEN=ConvertFrom-SecureString $bot
    OMP_SLACK_APP_TOKEN=ConvertFrom-SecureString $app
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $configPath) -Force | Out-Null
  $values | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  Write-Host 'Saved. Start your normal OMP, open the conversation you want, and enter /slack.'
} finally {
  $bot.Dispose(); $app.Dispose()
  Remove-Variable botText,appText,values -ErrorAction SilentlyContinue
}
