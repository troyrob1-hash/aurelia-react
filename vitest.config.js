name: Aurelia FMS — Daily Smoke Test

on:
  schedule:
    # Runs at 6am EST every day (11:00 UTC)
    - cron: '0 11 * * *'
  # Allow manual trigger from GitHub Actions tab
  workflow_dispatch:

jobs:
  smoke-test:
    name: Run smoke tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install firebase-admin
        run: npm install firebase-admin --no-save

      - name: Run smoke tests
        env:
          FIREBASE_PROJECT_ID:   ${{ secrets.FIREBASE_PROJECT_ID }}
          FIREBASE_CLIENT_EMAIL: ${{ secrets.FIREBASE_CLIENT_EMAIL }}
          FIREBASE_PRIVATE_KEY:  ${{ secrets.FIREBASE_PRIVATE_KEY }}
        run: npx vitest run tests/smoke.test.js --reporter=verbose

      - name: Post health report on failure
        if: failure()
        run: |
          echo "❌ AURELIA FMS SMOKE TEST FAILED — $(date)"
          echo "Check GitHub Actions for details: ${{ github.server_url }}/${{ github.repository }}/actions"