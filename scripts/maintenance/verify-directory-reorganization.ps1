[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [Parameter(Mandatory = $true)]
    [string[]]$MappingPath,
    [ValidateSet('Before', 'After', 'Audit')]
    [string]$Phase = 'Audit',
    [string]$BaselinePath,
    [switch]$CheckPython
)

$ErrorActionPreference = 'Stop'
$issues = New-Object 'System.Collections.Generic.List[string]'
$mappingInputs = New-Object 'System.Collections.Generic.List[string]'
foreach ($mappingInput in $MappingPath) {
    if ($mappingInput -match ',' -and -not (Test-Path -LiteralPath $mappingInput)) {
        foreach ($part in $mappingInput.Split(',')) { [void]$mappingInputs.Add($part.Trim()) }
    }
    else { [void]$mappingInputs.Add($mappingInput) }
}
$MappingPath = @($mappingInputs | ForEach-Object { $_ })

function Add-Issue {
    param([string]$Message)
    [void]$script:issues.Add($Message)
}

function Get-FullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([IO.Path]::IsPathRooted($Path)) {
        $candidate = [IO.Path]::GetFullPath($Path)
    }
    else {
        $candidate = [IO.Path]::GetFullPath((Join-Path $RootPath $Path))
    }

    $rootWithSeparator = $RootPath.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if ($candidate -ne $RootPath -and -not $candidate.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label resolves outside workspace root: $Path"
    }
    return $candidate
}

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RootPath
    )

    if ($Path -eq $RootPath) { return '.' }
    return $Path.Substring($RootPath.TrimEnd([char[]]@('\', '/')).Length + 1).Replace('\', '/')
}

function Get-TreeState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$RootPath
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            exists = $false
            relative = Get-RelativePath -Path $Path -RootPath $RootPath
            kind = $null
            fileCount = 0
            directoryCount = 0
            byteCount = [int64]0
            treeSha256 = $null
            reparsePointCount = 0
        }
    }

    $item = Get-Item -LiteralPath $Path -Force
    $files = if ($item.PSIsContainer) {
        @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force)
    }
    else { @($item) }
    $directories = if ($item.PSIsContainer) {
        @(Get-ChildItem -LiteralPath $Path -Recurse -Directory -Force)
    }
    else { @() }
    $allItems = @($item) + $files + $directories
    $reparseCount = @($allItems | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count

    $entries = New-Object 'System.Collections.Generic.List[string]'
    [int64]$bytes = 0
    foreach ($file in ($files | Sort-Object FullName)) {
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $relative = if ($item.PSIsContainer) {
            $file.FullName.Substring($item.FullName.TrimEnd([char[]]@('\', '/')).Length + 1).Replace('\', '/')
        }
        else { $file.Name }
        [int64]$bytes += $file.Length
        [void]$entries.Add("$relative`t$file.Length`t$hash")
    }

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $payload = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
        $treeHash = ([BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }

    [pscustomobject]@{
        exists = $true
        relative = Get-RelativePath -Path $Path -RootPath $RootPath
        kind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
        fileCount = $files.Count
        directoryCount = $directories.Count
        byteCount = $bytes
        treeSha256 = $treeHash
        reparsePointCount = $reparseCount
    }
}

function Test-PlaceholderTarget {
    param([string]$Target)
    if ($Target -match '^\s*<[^>]+>\s*$') { return $true }
    if ($Target -match '(?i)(\.\.\.|path/to|your[-_ ](?:path|file)|example\.com|placeholder|<root>)') { return $true }
    return $false
}

function Get-MarkdownLinks {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath
    )

    $excluded = @('\.git\', '\.worktrees\', '\node_modules\')
    $files = @(Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter '*.md' -Force | Where-Object {
        $full = $_.FullName
        -not ($excluded | Where-Object { $full -match [regex]::Escape($_) })
    })
    $pattern = '(?<image>!)?\[[^\]]*\]\((?<target><[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)'
    $result = New-Object 'System.Collections.Generic.List[object]'

    foreach ($file in $files) {
        $lines = [IO.File]::ReadAllLines($file.FullName)
        $fenceChar = $null
        $fenceLength = 0
        for ($index = 0; $index -lt $lines.Count; $index++) {
            $line = $lines[$index]
            $fence = [regex]::Match($line, '^\s*(?<char>`{3,}|~{3,})')
            if ($fence.Success) {
                $marker = $fence.Groups['char'].Value
                $markerChar = $marker.Substring(0, 1)
                if ($null -eq $fenceChar) {
                    $fenceChar = $markerChar
                    $fenceLength = $marker.Length
                }
                elseif ($markerChar -eq $fenceChar -and $marker.Length -ge $fenceLength) {
                    $fenceChar = $null
                    $fenceLength = 0
                }
                continue
            }
            if ($null -ne $fenceChar) { continue }

            foreach ($match in [regex]::Matches($line, $pattern)) {
                $rawTarget = $match.Groups['target'].Value.Trim()
                $target = $rawTarget.Trim([char[]]@('<', '>'))
                $withoutAnchor = ($target -split '[#?]', 2)[0]
                if ([string]::IsNullOrWhiteSpace($withoutAnchor)) { continue }
                if ($withoutAnchor -match '^[A-Za-z][A-Za-z0-9+.-]*:' -and $withoutAnchor -notmatch '^[A-Za-z]:[\\/]') { continue }

                $placeholder = Test-PlaceholderTarget -Target $target
                $resolved = $null
                $exists = $false
                if (-not $placeholder) {
                    try {
                        $candidate = if ([IO.Path]::IsPathRooted($withoutAnchor)) {
                            [IO.Path]::GetFullPath($withoutAnchor)
                        }
                        else {
                            [IO.Path]::GetFullPath((Join-Path $file.DirectoryName ($withoutAnchor.Replace('/', '\'))))
                        }
                        $resolved = Get-RelativePath -Path $candidate -RootPath $RootPath
                        $exists = Test-Path -LiteralPath $candidate
                    }
                    catch {
                        $resolved = $null
                        $exists = $false
                    }
                }

                [void]$result.Add([pscustomobject]@{
                    source = Get-RelativePath -Path $file.FullName -RootPath $RootPath
                    line = $index + 1
                    kind = if ($match.Groups['image'].Success) { 'image' } else { 'link' }
                    target = $target
                    resolved = $resolved
                    exists = $exists
                    placeholder = $placeholder
                })
            }
        }
    }
    return @($result | ForEach-Object { $_ })
}

function Get-BaselineKey {
    param(
        [Parameter(Mandatory = $true)]$Link,
        [Parameter(Mandatory = $true)]$Migrations
    )

    $source = ([string]$Link.source).Replace('\', '/')
    foreach ($migration in $Migrations) {
        $from = ([string]$migration.source).Replace('\', '/').TrimEnd([char]'/')
        $to = ([string]$migration.destination).Replace('\', '/').TrimEnd([char]'/')
        if ($source -eq $from) {
            $source = $to
            break
        }
        if ($source.StartsWith("$from/", [StringComparison]::OrdinalIgnoreCase)) {
            $source = "$to/$($source.Substring($from.Length + 1))"
            break
        }
    }
    return "$source|$($Link.kind)|$($Link.target)"
}

function Get-PythonSyntaxResult {
    param([string]$RootPath)
    $files = @(Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter '*.py' -Force | Where-Object {
        $_.FullName -notmatch '\\.git\\|\\.worktrees\\|\\node_modules\\'
    })
    if ($files.Count -eq 0) {
        return [pscustomobject]@{ checked = $false; fileCount = 0; errors = @(); reason = 'no Python files' }
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -eq $python) {
        return [pscustomobject]@{ checked = $false; fileCount = $files.Count; errors = @(); reason = 'python.exe unavailable' }
    }
    $errors = New-Object 'System.Collections.Generic.List[object]'
    $code = 'import ast,sys; p=sys.argv[1]; ast.parse(open(p,encoding=chr(117)+chr(116)+chr(102)+chr(45)+chr(56)).read(),filename=p); print(p)'
    foreach ($file in $files) {
        $output = & $python.Source -c $code $file.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            [void]$errors.Add([pscustomobject]@{ file = Get-RelativePath -Path $file.FullName -RootPath $RootPath; message = ($output -join "`n") })
        }
    }
    return [pscustomobject]@{ checked = $true; fileCount = $files.Count; errors = @($errors | ForEach-Object { $_ }); reason = $null }
}

$rootFull = (Resolve-Path -LiteralPath $Root).ProviderPath
$baseline = $null
$mapping = $null
$migrations = @()
$migrationResults = New-Object 'System.Collections.Generic.List[object]'
$markdown = @()
$python = $null

try {
    $mappingDocuments = New-Object 'System.Collections.Generic.List[object]'
    foreach ($mappingFile in $MappingPath) {
        if (-not (Test-Path -LiteralPath $mappingFile -PathType Leaf)) { throw "mapping file not found: $mappingFile" }
        [void]$mappingDocuments.Add((Get-Content -LiteralPath $mappingFile -Raw -Encoding UTF8 | ConvertFrom-Json))
    }
    foreach ($mappingDocument in @($mappingDocuments | ForEach-Object { $_ })) {
        if ($mappingDocument.migrations) {
            $migrations += @($mappingDocument.migrations)
        }
        elseif ($mappingDocument.mapping) {
            $migrations += @($mappingDocument.mapping)
        }
        elseif ($mappingDocument.files) {
            $migrations += @($mappingDocument.files)
        }
    }
    if ($migrations.Count -eq 0) { throw 'mapping must contain a non-empty migrations array' }
    if ($BaselinePath) {
        if (-not (Test-Path -LiteralPath $BaselinePath -PathType Leaf)) { throw "baseline file not found: $BaselinePath" }
        $baseline = Get-Content -LiteralPath $BaselinePath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    $seenSources = @{}
    $seenDestinations = @{}
    foreach ($migration in $migrations) {
        if ([string]::IsNullOrWhiteSpace($migration.source) -or [string]::IsNullOrWhiteSpace($migration.destination)) {
            Add-Issue 'each migration needs non-empty source and destination'
            continue
        }
        try {
            $sourcePath = Get-FullPath -Path ([string]$migration.source) -RootPath $rootFull -Label 'source'
            $destinationPath = Get-FullPath -Path ([string]$migration.destination) -RootPath $rootFull -Label 'destination'
            $sourceKey = $sourcePath.ToLowerInvariant()
            $destinationKey = $destinationPath.ToLowerInvariant()
            if ($seenSources.ContainsKey($sourceKey)) { Add-Issue "duplicate source: $($migration.source)" }
            if ($seenDestinations.ContainsKey($destinationKey)) { Add-Issue "duplicate destination: $($migration.destination)" }
            $seenSources[$sourceKey] = $true
            $seenDestinations[$destinationKey] = $true

            $sourceState = Get-TreeState -Path $sourcePath -RootPath $rootFull
            $destinationState = Get-TreeState -Path $destinationPath -RootPath $rootFull
            if ($sourceState.reparsePointCount -gt 0) { Add-Issue "source contains reparse points: $($migration.source)" }
            if ($destinationState.reparsePointCount -gt 0) { Add-Issue "destination contains reparse points: $($migration.destination)" }
            if ($Phase -eq 'Before') {
                if (-not $sourceState.exists) { Add-Issue "before phase source missing: $($migration.source)" }
                if ($destinationState.exists) { Add-Issue "before phase destination conflict: $($migration.destination)" }
            }
            elseif ($Phase -eq 'After') {
                if ($sourceState.exists) { Add-Issue "after phase source still exists: $($migration.source)" }
                if (-not $destinationState.exists) { Add-Issue "after phase destination missing: $($migration.destination)" }
            }

            $matches = $null
            if ($baseline) {
                $baselineMigration = @($baseline.migrations) | Where-Object { $_.source.relative -eq $sourceState.relative } | Select-Object -First 1
                if ($baselineMigration) {
                    $matches = ($baselineMigration.source.treeSha256 -eq $destinationState.treeSha256 -and $baselineMigration.source.fileCount -eq $destinationState.fileCount -and $baselineMigration.source.byteCount -eq $destinationState.byteCount)
                    if ($Phase -eq 'After' -and -not $matches) { Add-Issue "destination content differs from baseline source: $($migration.destination)" }
                }
                elseif ($Phase -eq 'After') { Add-Issue "baseline has no source record: $($migration.source)" }
            }

            [void]$migrationResults.Add([pscustomobject]@{
                source = $sourceState
                destination = $destinationState
                integrity = [pscustomobject]@{ treeSha256MatchesBaseline = $matches }
            })
        }
        catch { Add-Issue $_.Exception.Message }
    }

    $markdownLinks = @(Get-MarkdownLinks -RootPath $rootFull)
    $missing = @($markdownLinks | Where-Object { -not $_.exists -and -not $_.placeholder })
    $preExisting = New-Object 'System.Collections.Generic.List[object]'
    $newlyBroken = New-Object 'System.Collections.Generic.List[object]'
    $baselineKeys = @{}
    if ($baseline -and $baseline.markdown -and $baseline.markdown.links) {
        foreach ($link in @($baseline.markdown.links) | Where-Object { -not $_.exists -and -not $_.placeholder }) {
            $baselineKeys[(Get-BaselineKey -Link $link -Migrations $migrations)] = $true
        }
    }
    foreach ($link in $missing) {
        if ($baselineKeys.ContainsKey((Get-BaselineKey -Link $link -Migrations $migrations))) { [void]$preExisting.Add($link) }
        else { [void]$newlyBroken.Add($link) }
    }
    $markdown = [pscustomobject]@{
        links = $markdownLinks
        summary = [pscustomobject]@{
            fileCount = @($markdownLinks | Select-Object -ExpandProperty source -Unique).Count
            localLinkCount = $markdownLinks.Count
            missingCount = $missing.Count
            placeholderCount = @($markdownLinks | Where-Object { $_.placeholder }).Count
            preExistingBrokenCount = $preExisting.Count
            newlyBrokenCount = $newlyBroken.Count
            preExistingBroken = @($preExisting | ForEach-Object { $_ })
            newlyBroken = @($newlyBroken | ForEach-Object { $_ })
        }
    }
    if ($CheckPython) {
        $python = Get-PythonSyntaxResult -RootPath $rootFull
        foreach ($error in @($python.errors)) { Add-Issue "Python syntax: $($error.file): $($error.message)" }
    }
}
catch { Add-Issue $_.Exception.Message }

$markdownMissingCount = 0
if ($null -ne $markdown -and $null -ne $markdown.PSObject.Properties['summary']) {
    $markdownMissingCount = $markdown.summary.missingCount
}
$report = [pscustomobject]@{
    schema = 'directory-reorganization-verification.v1'
    root = $rootFull
    phase = $Phase
    mappingPath = @($MappingPath)
    baselinePath = if ($BaselinePath -and (Test-Path -LiteralPath $BaselinePath)) { (Resolve-Path -LiteralPath $BaselinePath).ProviderPath } else { $null }
    passed = ($issues.Count -eq 0)
issues = @($issues | ForEach-Object { $_ })
    summary = [pscustomobject]@{
        migrationCount = $migrationResults.Count
        issueCount = $issues.Count
        markdownMissingCount = $markdownMissingCount
    }
    migrations = @($migrationResults | ForEach-Object { $_ })
    markdown = $markdown
    python = $python
}
$report | ConvertTo-Json -Depth 30
if ($issues.Count -gt 0) { exit 1 }
