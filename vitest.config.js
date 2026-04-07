pbpaste > vitest.config.js
git add vitest.config.js
git commit -m "fix: restore vitest.config.js"
git push origin develop
git checkout main
git merge develop
git push origin main
git checkout develop