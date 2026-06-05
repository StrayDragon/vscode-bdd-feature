# Justfile for vscode-bdd-feature

default:
    @just -l

# Install dependencies
install:
    #!/usr/bin/env bash
    set -e
    echo "📥 Installing dependencies..."
    pnpm install

# Lint and check types
lint:
    #!/usr/bin/env bash
    set -e
    echo "🔍 Running linting and type checking..."
    pnpm run lint
    pnpm run check-types

# Build the extension
build:
    #!/usr/bin/env bash
    set -e
    echo "🔨 Building extension..."
    pnpm run package

# Package the extension as a VSIX file
package-vsix:
    #!/usr/bin/env bash
    set -e
    echo "📦 Packaging vscode-bdd-feature extension as VSIX..."

    # Package the extension with a consistent name (no version in filename)
    echo "📦 Creating VSIX package..."
    npx vsce package --out vscode-bdd-feature.vsix

    echo "✅ VSIX package created successfully!"

    # List the created VSIX file
    ls -la vscode-bdd-feature.vsix 2>/dev/null || echo "No VSIX file found in current directory"

# Run tests
test:
    #!/usr/bin/env bash
    set -e
    echo "🧪 Running tests..."
    pnpm run test
