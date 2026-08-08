<#
.SYNOPSIS
  安装 AgentRD 的 7 个 skill 到 ~/.claude/skills/。

.DESCRIPTION
  默认 dry-run，只打印将要做什么。确认无误后加 -Apply 真正执行。
  -EnableAgentTeams 会往 ~/.claude/settings.json 写入
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1（会先备份原文件）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  powershell -ExecutionPolicy Bypass -File install.ps1 -Apply -EnableAgentTeams
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$EnableAgentTeams,
    [string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcSkills = Join-Path $here 'skills'
$dstSkills = Join-Path $ClaudeHome 'skills'

if (-not (Test-Path $srcSkills)) {
    Write-Host "找不到 skills 目录: $srcSkills" -ForegroundColor Red
    exit 2
}

$mode = 'DRY-RUN（不会改任何东西）'
if ($Apply) { $mode = 'APPLY' }

Write-Host ""
Write-Host "=== AgentRD install [$mode] ===" -ForegroundColor Cyan
Write-Host "    源:   $srcSkills" -ForegroundColor DarkGray
Write-Host "    目标: $dstSkills" -ForegroundColor DarkGray
Write-Host ""

$skills = Get-ChildItem $srcSkills -Directory | Sort-Object Name

foreach ($s in $skills) {
    $dst = Join-Path $dstSkills $s.Name
    $exists = Test-Path $dst
    $tag = 'install'
    $color = 'Green'
    if ($exists) { $tag = 'OVERWRITE'; $color = 'Yellow' }

    Write-Host ("  {0,-10} {1}" -f $tag, $s.Name) -ForegroundColor $color

    if ($Apply) {
        if (-not (Test-Path $dstSkills)) { New-Item -ItemType Directory -Path $dstSkills -Force | Out-Null }
        if ($exists) {
            $bak = "$dst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Move-Item $dst $bak
            Write-Host ("             备份旧版本 -> {0}" -f (Split-Path -Leaf $bak)) -ForegroundColor DarkGray
        }
        Copy-Item $s.FullName $dst -Recurse
    }
}

if ($EnableAgentTeams) {
    Write-Host ""
    Write-Host "  --- Agent Teams ---" -ForegroundColor Cyan
    $settingsPath = Join-Path $ClaudeHome 'settings.json'

    if (Test-Path $settingsPath) {
        $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $settings = [pscustomobject]@{}
    }

    if ($null -eq $settings.env) {
        $settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $current = $settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    if ($current -eq '1') {
        Write-Host "  已经是 1，无需改动" -ForegroundColor DarkGray
    } else {
        Write-Host "  将设置 env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = 1  (当前: '$current')" -ForegroundColor Yellow
        if ($Apply) {
            if (Test-Path $settingsPath) {
                $bak = "$settingsPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                Copy-Item $settingsPath $bak
                Write-Host "  已备份 -> $(Split-Path -Leaf $bak)" -ForegroundColor DarkGray
            }
            $settings.env | Add-Member -NotePropertyName CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -NotePropertyValue '1' -Force
            $settings | ConvertTo-Json -Depth 20 | Out-File -FilePath $settingsPath -Encoding utf8
            Write-Host "  已写入 $settingsPath" -ForegroundColor Green
        }
    }
    Write-Host ""
    Write-Host "  注意：Windows 上只能用 in-process 模式（主终端 Shift+上/下 切换队友）。" -ForegroundColor DarkGray
    Write-Host "        split panes 需要 tmux 或 iTerm2，Windows Terminal 和 VS Code 集成终端都不支持。" -ForegroundColor DarkGray
}

Write-Host ""
if ($Apply) {
    Write-Host "=== 安装完成 ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步：" -ForegroundColor Cyan
    Write-Host "  1. cd 到你的项目" -ForegroundColor Gray
    Write-Host "  2. powershell -ExecutionPolicy Bypass -File `"$here\scripts\init-rd.ps1`"" -ForegroundColor Gray
    Write-Host "  3. 重启 Claude Code，调用 /rd" -ForegroundColor Gray
} else {
    Write-Host "=== 这是 dry-run。确认无误后重跑并加 -Apply ===" -ForegroundColor Yellow
}
Write-Host ""
