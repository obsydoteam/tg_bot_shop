$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env")) {
  Write-Error "Missing .env file. Create it from .env.example first."
}

docker compose up -d --build
Write-Host "OBSYDO VPN bot deployed."
