# Шепіт Web

Диктофон і розпізнавання мовлення в браузері на моделі NVIDIA Nemotron 3.5
(sherpa-onnx, WebAssembly). Аудіо й текст не залишають комп'ютер: з мережі
один раз завантажується лише модель (~680 МБ, Hugging Face), далі вона
береться з кешу браузера.

- `web/` — сайт (GitHub Pages).
- `wasm/`, `scripts/build-wasm.sh` — збірка рушія sherpa-onnx під WebAssembly.
- `test/node-test.js` — перевірка рушія в Node на тестових записах моделі.
- `test/e2e.py` — перевірка сайту в Chromium з віртуальним мікрофоном.

Збірка, тести й публікація — `.github/workflows/build-deploy.yml`.
