# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [2.1.0](https://github.com/K4zoku/FF-WebHID/compare/v2.0.0...v2.1.0) (2026-07-19)


### Features

* background fetch resource ([6b9005e](https://github.com/K4zoku/FF-WebHID/commit/6b9005e0f2ff46114d43b8f2d6bda734115b8e5e))
* browser action ([5836f33](https://github.com/K4zoku/FF-WebHID/commit/5836f33d2592a40bf491f6709bd109ec578434b4))
* chromium support ([3f7f152](https://github.com/K4zoku/FF-WebHID/commit/3f7f152938ee5ef34fede0f2d95b1535efa1ce30))
* control permission check ([e0230b5](https://github.com/K4zoku/FF-WebHID/commit/e0230b51312bc6a787a4c36e92e62692d3a4a890))
* hotplug handler for popup and device picker ([c0bfbd0](https://github.com/K4zoku/FF-WebHID/commit/c0bfbd035f281762772b286e85f67a14aceffa32))
* match Chromium's HID blocklist exactly ([da13dc9](https://github.com/K4zoku/FF-WebHID/commit/da13dc90a34aa73a646ae6446797850dd62f00b4))
* notifications ([dcfcc48](https://github.com/K4zoku/FF-WebHID/commit/dcfcc48d73f98e763eaea6bee90e8f9d8a7137ae))
* page action device picker ([7ace840](https://github.com/K4zoku/FF-WebHID/commit/7ace840ec7864b350c17e75faa04be3b8e0074fa))
* test bridge ([65c59b7](https://github.com/K4zoku/FF-WebHID/commit/65c59b75770b12ff99ac1aa6e23ae8218eb2c3c9))
* test no war ([6a74114](https://github.com/K4zoku/FF-WebHID/commit/6a74114442e9ef54a106302eda3305012a45b2df))
* user activation ([db28087](https://github.com/K4zoku/FF-WebHID/commit/db2808783fb85aaf7b7947ebdcf663ef910b3692))
* visibility transition ([e3e176e](https://github.com/K4zoku/FF-WebHID/commit/e3e176ec0b4377ff34c4af5f0c0f526fbb2218d5))
* window picker ([a6fd6a2](https://github.com/K4zoku/FF-WebHID/commit/a6fd6a21ed447bb8ab37e7c8425ce152b8edffe1))


### Bug Fixes

* add defense layer to ws ([055ca88](https://github.com/K4zoku/FF-WebHID/commit/055ca88505bd48ed44f011800f3110463a850a07))
* cache ([9c63c6c](https://github.com/K4zoku/FF-WebHID/commit/9c63c6c4e667f0255fb5b43cbfead373a5ff9566))
* critical promise leaks, panics, and spec event target ([9e23f9b](https://github.com/K4zoku/FF-WebHID/commit/9e23f9b0e7c8a7fd515cb32e3e539d4b3c472045))
* custom element didnt work, back to plain class ([e47558c](https://github.com/K4zoku/FF-WebHID/commit/e47558c314726d859b3bf068c38c4bca5531e217))
* debug ce ([226eac8](https://github.com/K4zoku/FF-WebHID/commit/226eac84aea2bdb59fcebeb413af1c4310d95ce5))
* device picker custom element ([c4c61c0](https://github.com/K4zoku/FF-WebHID/commit/c4c61c09448340207ed95461550bc0b822031dcd))
* device picker live update ([29eb053](https://github.com/K4zoku/FF-WebHID/commit/29eb053eaf49ae236453f46e418add282bf1f8cc))
* device picker now show immediately ([fb8310c](https://github.com/K4zoku/FF-WebHID/commit/fb8310ccd62e57bb5f606910a3ed590bb9f6b823))
* device template got deleted ([94ff944](https://github.com/K4zoku/FF-WebHID/commit/94ff944496a08a71295cb2af0149813c1da3ef12))
* EventTarget on HID object ([d8c7fd1](https://github.com/K4zoku/FF-WebHID/commit/d8c7fd1bdee7c95a0b2561b045ea302d4936837a))
* global context for chromium ([87f882f](https://github.com/K4zoku/FF-WebHID/commit/87f882f491921c5933e20d5d2d759971c095cf2b))
* keep NM connection alive on malformed JSON frame ([31db13c](https://github.com/K4zoku/FF-WebHID/commit/31db13c7c8837d4600dcdcd1a02b16bf4a6c7811))
* lint warnings ([ef19f54](https://github.com/K4zoku/FF-WebHID/commit/ef19f543893b5178069e866dfeae7ee942915231))
* maybe fix [#2](https://github.com/K4zoku/FF-WebHID/issues/2), added some more diagnostics log ([b3b871b](https://github.com/K4zoku/FF-WebHID/commit/b3b871b4de8b06559dec1d719a141b1758842d08))
* order ([3308296](https://github.com/K4zoku/FF-WebHID/commit/3308296c8c3238c545e0a849c544deaf7516f407))
* page port auth ([e59223a](https://github.com/K4zoku/FF-WebHID/commit/e59223aa8ef06a813a963f142cfccf0e288423d3))
* picker icons ([ab58929](https://github.com/K4zoku/FF-WebHID/commit/ab589296a13c2d695499ea540c167f57c9c661b4))
* picker popup ([b92c32d](https://github.com/K4zoku/FF-WebHID/commit/b92c32d2732627413ab019ce3a8fa773f14b805b))
* poison-recovery, hotplug cleanup, spec ([5b988a1](https://github.com/K4zoku/FF-WebHID/commit/5b988a160091afd526f43f796e986f9931efb06e))
* render duplicated ([07cd68a](https://github.com/K4zoku/FF-WebHID/commit/07cd68ac9cf6c09687a59752a4f2ac60e67916d1))
* render empty list instead ([6805d3c](https://github.com/K4zoku/FF-WebHID/commit/6805d3c19b01e4ec47eff0b12bec77468c41f7ff))
* responsive ([05dc326](https://github.com/K4zoku/FF-WebHID/commit/05dc32662247c2ded9a73afb0e2392b6381c9bdd))
* stable deviceId ([86c46ec](https://github.com/K4zoku/FF-WebHID/commit/86c46ecc4af40fc192ad5e6b83a5639bedf0b3e8))
* state leaks and concurrent-open races ([5ad7cec](https://github.com/K4zoku/FF-WebHID/commit/5ad7cec7bdc055ff9a84a65c2ec1e3ae139b836b))
* test page ([9a67961](https://github.com/K4zoku/FF-WebHID/commit/9a67961642c5adb894e369fef2077e55d50383ca))
* transitionend ([14c7573](https://github.com/K4zoku/FF-WebHID/commit/14c7573b1c11f447d30687f62781cb41cb2de861))
* wait for next frame to trigger transition ([18ed436](https://github.com/K4zoku/FF-WebHID/commit/18ed436c4b24c1ba01d0f7fd827ed10a560acc17))
* ws control can open device now - intended behavior ([9adf5bf](https://github.com/K4zoku/FF-WebHID/commit/9adf5bfb1ffca93a671fe5a849c32e7d4c2b223c))


### Performance

* cut 1 hop for ws ([378929f](https://github.com/K4zoku/FF-WebHID/commit/378929f368824613dd52ab49b40b4e477c0f169d))
* latency optimization ([da559dd](https://github.com/K4zoku/FF-WebHID/commit/da559dd4593623bda48993b088db283b8b8458ca))


### Code Refactoring

* cleanup ([0b4e669](https://github.com/K4zoku/FF-WebHID/commit/0b4e66975207c6eb1c97086b302440f916007a8d))
* cleanup chromium artifact, reformat code ([1bf098c](https://github.com/K4zoku/FF-WebHID/commit/1bf098c1ca6d53c73f910ce631f6f9bcffa3edeb))
* cleanup chromium artifacts 2 ([788e7c7](https://github.com/K4zoku/FF-WebHID/commit/788e7c79b844168b7ce24985a52fa018cbd0dce1))
* cleanup left over prop ([dd4331f](https://github.com/K4zoku/FF-WebHID/commit/dd4331fa1221afe452d334a768b932126d46899f))
* custom element ([171f097](https://github.com/K4zoku/FF-WebHID/commit/171f09772a72bb9e7142c88f340a60bd59ff6413))
* deduplicate logic, remove dead code ([a1eb6ab](https://github.com/K4zoku/FF-WebHID/commit/a1eb6abad1be933ecee574155cb3e9968a725139))
* IIFE ([cb39cfc](https://github.com/K4zoku/FF-WebHID/commit/cb39cfcd6548039fec984036a97e22b545ac0894))
* IIFE 2 ([b84cb01](https://github.com/K4zoku/FF-WebHID/commit/b84cb01cdc9ceb2af798420469e6982ca83bde5f))
* reformat ([d78654a](https://github.com/K4zoku/FF-WebHID/commit/d78654a5e41446b6d313e19637af48066c7fc626))
* reformat code ([3c904c3](https://github.com/K4zoku/FF-WebHID/commit/3c904c34c052d02e13c83e99fddd019b043df0e8))
* reformat rs code ([22c3f26](https://github.com/K4zoku/FF-WebHID/commit/22c3f2660179571fa51097e3404c87fdab7d1eaa))
* rename ([52509c8](https://github.com/K4zoku/FF-WebHID/commit/52509c80710a0be4cf879488b8323615598f0eaa))
* rename, merge, cleanup ([179225a](https://github.com/K4zoku/FF-WebHID/commit/179225ab958d525e096cd8d5199825846e1c2619))
* rename, module import export ([eea040c](https://github.com/K4zoku/FF-WebHID/commit/eea040c19371d9f509879aa7b609e61ef3f2a1d9))


### Documentation

* update DEVELOPMENT.md ([1151a65](https://github.com/K4zoku/FF-WebHID/commit/1151a65c233ede3e4cc93aa367a131c78c1bcaeb))
* update stale info ([b961fd9](https://github.com/K4zoku/FF-WebHID/commit/b961fd979acc26d4f7e3ad2c338ade178fcd6dba))


### CI/CD

* move audit to separate job ([7b84a8a](https://github.com/K4zoku/FF-WebHID/commit/7b84a8ab68cffc2588933a5c0cdaa92377f31791))
* use taiki-e/install-action for audit tools ([939c697](https://github.com/K4zoku/FF-WebHID/commit/939c6972169f4655dec464a8746aa47283141dc9))


### Chores

* add gate to linux only function ([6964862](https://github.com/K4zoku/FF-WebHID/commit/6964862daac165de134d9afd3f8a8df1709b6a6b))
* add supply-chain hardening (cargo-audit, cargo-deny, npm-audit, license fields) ([cc1ba8d](https://github.com/K4zoku/FF-WebHID/commit/cc1ba8d5c66a025cf3690c8731f92ad37caeb774))

## [2.0.0](https://github.com/K4zoku/FF-WebHID/compare/v1.6.6...v2.0.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* numberic dev id
* status code
* single char fields name
* packed message
* remove perf logging
* remove device hash, use deviceId instead
* remove bridge ws
* remove SAB

### Features

* actual daemon-as-nm-host ([8c2e69a](https://github.com/K4zoku/FF-WebHID/commit/8c2e69ae0ef8459cb6e2f6a58e03b0fc4efbf8b8))
* adaptive batching ([1209587](https://github.com/K4zoku/FF-WebHID/commit/12095876a46e5f896e86839f894db8ff5fbb1b1a))
* control plane ([6cec6bd](https://github.com/K4zoku/FF-WebHID/commit/6cec6bd96d3f3d303eefd4db234973b317346911))
* control worker ([f1b416f](https://github.com/K4zoku/FF-WebHID/commit/f1b416f4c13c2e8e89b1d4771ca4d7530ac7c7b4))
* daemon as nm host ([feea187](https://github.com/K4zoku/FF-WebHID/commit/feea187e8a2a2f17996371f8f527259ae3923bf7))
* daemon-nm-host wrapper ([40cb39e](https://github.com/K4zoku/FF-WebHID/commit/40cb39e8f629411d90d42dac62c28c901faf0e07))
* **daemon,nm,linux:** use XDG_RUNTIME_DIR for normal user ([7364de9](https://github.com/K4zoku/FF-WebHID/commit/7364de979985c886b6dbd50543fea87c0dc80111))
* data plane switcher ([ad3420f](https://github.com/K4zoku/FF-WebHID/commit/ad3420fdf27de14d5151850f95d42c1bf3df7d8e))
* dynamic buffer size ([4287cdb](https://github.com/K4zoku/FF-WebHID/commit/4287cdbe5313031fff26cdc2cf1eb9897e469da3))
* fire-and-forget for nm data plane ([f390fd5](https://github.com/K4zoku/FF-WebHID/commit/f390fd56216a4939eaed17b49f2b874b482bbb4b))
* limit to group permission ([951119b](https://github.com/K4zoku/FF-WebHID/commit/951119b7c20e43be381fb2d652354acfdbad0c0a))
* log level per-site ([38698d2](https://github.com/K4zoku/FF-WebHID/commit/38698d26253cd82029f5560f60a87fe837d20341))
* move collections parser to daemon ([ab0f066](https://github.com/K4zoku/FF-WebHID/commit/ab0f0661d9058421935b0a28270784068cd46c3b))
* multi tab support ([d23f5a5](https://github.com/K4zoku/FF-WebHID/commit/d23f5a594bbcc312ebc50b477981e66f2822833b))
* nm host now act as a thin forwarder ([33d0f43](https://github.com/K4zoku/FF-WebHID/commit/33d0f43d92becfc52bbc623b2c9024c399f9948d))
* NM only with message channel & direct port ([63bdb04](https://github.com/K4zoku/FF-WebHID/commit/63bdb0415023bd69d0377488a8e7a0f00758edc1))
* numberic dev id ([7e2e024](https://github.com/K4zoku/FF-WebHID/commit/7e2e024e6d4f8c6c60b4b93e8f9d2fd627e2d66c))
* origin gate ([b672c73](https://github.com/K4zoku/FF-WebHID/commit/b672c73946e98af42211a23841f270791722d353))
* packed message ([9e30d3f](https://github.com/K4zoku/FF-WebHID/commit/9e30d3f254f03ec27b4382bc2ee0c457ec3fe129))
* popup dataplane toggle ([959680c](https://github.com/K4zoku/FF-WebHID/commit/959680c37d002d0e5bdee406aebf5c78d902572d))
* remove bridge ws ([eb98d4e](https://github.com/K4zoku/FF-WebHID/commit/eb98d4e36f5a556936840110621b13900aa3b0cf))
* remove device hash, use deviceId instead ([a7ad348](https://github.com/K4zoku/FF-WebHID/commit/a7ad34864bf747723298b8064be5b313ec9ed13b))
* remove perf logging ([b2ac4f1](https://github.com/K4zoku/FF-WebHID/commit/b2ac4f1400799280839c2910bcfeb88dbe53c958))
* remove SAB ([9cc391d](https://github.com/K4zoku/FF-WebHID/commit/9cc391d297e584d1badb9bc2a6cd6e1ae26339c9))
* sab toggle live ([34eac6c](https://github.com/K4zoku/FF-WebHID/commit/34eac6ca8f345ea6ff4225a1044eee393b2e2a2b))
* settings store ([9962fb0](https://github.com/K4zoku/FF-WebHID/commit/9962fb0f59f7e81694e26a5649d4c424c6a9d388))
* status code ([3b90097](https://github.com/K4zoku/FF-WebHID/commit/3b90097cf8b96c6188720c7f8fd795894f74880e))
* strict permission for user daemon ([e332004](https://github.com/K4zoku/FF-WebHID/commit/e33200444b37f4573295aa5b8c853f445a302ae1))
* update logger ([8e3a19c](https://github.com/K4zoku/FF-WebHID/commit/8e3a19c7cad158814e3045bf80a436a7839243c9))
* use native base64 function ([90f2dd3](https://github.com/K4zoku/FF-WebHID/commit/90f2dd3ecfd9dd084b806b2b4eaef1774a06ffb3))
* worker ws ([d3807e6](https://github.com/K4zoku/FF-WebHID/commit/d3807e6de7283a29961dab8f82ec920ce8550a42))


### Bug Fixes

* add back collections normalizer ([c3fcb14](https://github.com/K4zoku/FF-WebHID/commit/c3fcb14d60aef1ff3cc15fc96b121a4d4a096d5a))
* audit fixes ([3ac81a0](https://github.com/K4zoku/FF-WebHID/commit/3ac81a0989c5e8ed227347edc6d69bb578825a1f))
* close the correct device ([2b59345](https://github.com/K4zoku/FF-WebHID/commit/2b593451b99984f073f44bcb67d70d0b5f2fd259))
* control ws spawn even when using control nm ([7f46382](https://github.com/K4zoku/FF-WebHID/commit/7f463827dc06427855b85e06ad88580e2cc9b5f5))
* device counter & saved device info ([2f624e9](https://github.com/K4zoku/FF-WebHID/commit/2f624e927811a1c61d8d74052c446c9ce7c7e32a))
* devid u32 fix ([2cdb2a5](https://github.com/K4zoku/FF-WebHID/commit/2cdb2a557c5dbe7a5a1ed58fd2d7d0fee5b9fe6b))
* do not wait for hot path on nm data plane ([3b9aa22](https://github.com/K4zoku/FF-WebHID/commit/3b9aa226a21c2e7cadb722520d18bb51bffbca0f))
* event construct ([c3f7f4b](https://github.com/K4zoku/FF-WebHID/commit/c3f7f4b38fb0fd0c3d80005d1e918eb932e179a4))
* event constructor ([ac8dce9](https://github.com/K4zoku/FF-WebHID/commit/ac8dce90c64b1565d5e664532ab8a98cd73d120f))
* event not arrive ([ca1e3e3](https://github.com/K4zoku/FF-WebHID/commit/ca1e3e36a4c7a950f2ff109e9467c047bbdfec57))
* event target ([a71cd0c](https://github.com/K4zoku/FF-WebHID/commit/a71cd0c3e1926f8603b9c5f9bc8f570813db4e93))
* faf ([2cf02c6](https://github.com/K4zoku/FF-WebHID/commit/2cf02c6520871bcedefe9cd59139f0be655ccfe5))
* hotplug bypassed blocklist ([5608d42](https://github.com/K4zoku/FF-WebHID/commit/5608d4264cd04fd912148bd4ba6d419f07e42dfa))
* input report event ([de0d9d6](https://github.com/K4zoku/FF-WebHID/commit/de0d9d6a0e40a23dbf8a2032ea9c1b10fdc63ce6))
* leftover ([bd6452c](https://github.com/K4zoku/FF-WebHID/commit/bd6452c9e5f279e633c73ccef2f8265f23f994d0))
* macos build ([f04620a](https://github.com/K4zoku/FF-WebHID/commit/f04620a58b6e35537e93ff41442930d6573b3c38))
* nm data plane + daemon collections normalizer ([f3c7fc4](https://github.com/K4zoku/FF-WebHID/commit/f3c7fc4805c870aeb1a0da87e0d5fab0a05df5f2))
* nm error propagation ([e6a2dd1](https://github.com/K4zoku/FF-WebHID/commit/e6a2dd11cdf3b66239f51a144ded3ea7241c9000))
* packed message ([f15f5e4](https://github.com/K4zoku/FF-WebHID/commit/f15f5e48fd20b0b4ee7c9223776790b8ed33ec23))
* reference error ([206f70b](https://github.com/K4zoku/FF-WebHID/commit/206f70ba83cc69e6fddea8323bde2b4ebc1e9f0b))
* remove direct port as it is not supported by firefox ([31e0cd5](https://github.com/K4zoku/FF-WebHID/commit/31e0cd54b15d9c73613503f2e58b58205de385a3))
* remove predictable token fallback ([92982b2](https://github.com/K4zoku/FF-WebHID/commit/92982b29d097bea1cbd115e3f22458c97aab8a28))
* remove task scheduler ([c001516](https://github.com/K4zoku/FF-WebHID/commit/c001516f1392e87db176452e149cf04dcd708281))
* rename to match format `/^\w+(\.\w+)*$/)` for ([ca150f7](https://github.com/K4zoku/FF-WebHID/commit/ca150f78b0a8332a0812429fa26d54a049fd3ffe))
* sab size ([ab33cca](https://github.com/K4zoku/FF-WebHID/commit/ab33cca2771c01e6ca74a61054eb38cab0e9d0f5))
* saved device in popup ([21f3ca6](https://github.com/K4zoku/FF-WebHID/commit/21f3ca64a4db6d79fbad193b9d288dec25b2b8bc))
* security ([d573713](https://github.com/K4zoku/FF-WebHID/commit/d573713a59f29fc2ec5db9ee6d21739cc2d4bca6))
* settings change bugs ([4c5ec1f](https://github.com/K4zoku/FF-WebHID/commit/4c5ec1fa046aa4f6fa892b6f6287b9de78ada331))
* settings save & worker tdz ([1cb919b](https://github.com/K4zoku/FF-WebHID/commit/1cb919b19e9ad9a0743dcfb2aeb2cf5fe060e2fa))
* settings sync, life cycle management ([6d0654c](https://github.com/K4zoku/FF-WebHID/commit/6d0654c85dc9fab10b2f0e4b4ef3674398f45257))
* site setting for data plane ([8754ab9](https://github.com/K4zoku/FF-WebHID/commit/8754ab9b811fc02e7c7744b793803be627af5dac))
* split async ([dd6bd7b](https://github.com/K4zoku/FF-WebHID/commit/dd6bd7bec8c14873ce55cb80e3de05789875d441))
* truncated byte ([d5fa14f](https://github.com/K4zoku/FF-WebHID/commit/d5fa14f2fb5237b5676adb8962a8b4a762fab389))
* wrong message type ([bd75412](https://github.com/K4zoku/FF-WebHID/commit/bd75412e25f2e8f2b571ff2c98fe57999289f7ee))
* ws control open device ([e8e9d04](https://github.com/K4zoku/FF-WebHID/commit/e8e9d04f1bcd23535bbebc05ac6474c61e091d91))
* ws dataplane ([6c40af0](https://github.com/K4zoku/FF-WebHID/commit/6c40af0556eae52858fe8a2dda9f2a539d68149f))


### Performance

* default to no batching (consume more cpu but lower latency) ([8763514](https://github.com/K4zoku/FF-WebHID/commit/876351410fec73c66ff954f095923ac0047fb474))
* early fire-and-forget ([84329e0](https://github.com/K4zoku/FF-WebHID/commit/84329e0d8a89846766439c2e974944e2f1185381))
* eliminate 8 copy by using rkyv for daemon <-> nm host ([f29d6ae](https://github.com/K4zoku/FF-WebHID/commit/f29d6ae645debf78ecbeaec28703b3bba97231ca))
* message channel ([e13e5ca](https://github.com/K4zoku/FF-WebHID/commit/e13e5ca5c6de50f34081cf1474d460bea0e172e3))
* nm host truly forward with zero-copy/alloc & daemon with thread ([05b9f31](https://github.com/K4zoku/FF-WebHID/commit/05b9f31e9989cdecfa134244911884cc27c57b7c))
* numberic action ([b899f22](https://github.com/K4zoku/FF-WebHID/commit/b899f22068df674e76ddfacf434e196f4481b45f))
* optimize data hop ([3389c50](https://github.com/K4zoku/FF-WebHID/commit/3389c50e5dbb602289ff61b5b6d623a50178880e))
* optimize tlv ([58ecf8e](https://github.com/K4zoku/FF-WebHID/commit/58ecf8e1121ab98af598ee6871269ac662bd21c3))
* postMessage with transfer ([7daf92c](https://github.com/K4zoku/FF-WebHID/commit/7daf92c680382b11b7318c76bbde7b310dfbaf18))
* reduce data copies, use base64 for context switching copy at O(1) ([b32f1b9](https://github.com/K4zoku/FF-WebHID/commit/b32f1b99c66fe05c9ab604f3a8c06f8ae4636dbe))
* set TCP_NODELAY ([792d8c4](https://github.com/K4zoku/FF-WebHID/commit/792d8c4b2002430d1925d4fc34bc2fcc6b1d7043))
* silent copy ([e173b9e](https://github.com/K4zoku/FF-WebHID/commit/e173b9e700088126384a71549b57e4b878704c8c))
* single char fields name ([503f93f](https://github.com/K4zoku/FF-WebHID/commit/503f93f864d05e06e877370374a1d2e13d3caaf1))
* skip close/open when switching data plane ([b418c7f](https://github.com/K4zoku/FF-WebHID/commit/b418c7febd09722b2f7fb33fbc8dedc5553214c8))
* uint8array for nm ([7e98317](https://github.com/K4zoku/FF-WebHID/commit/7e98317d1eea4b37359221b9777d4c2bb61aa609))
* use string/base64 instead of u8 array ([b5eb364](https://github.com/K4zoku/FF-WebHID/commit/b5eb364c680ae10c7bc2d23200b6328b9d96b2fd))


### Code Refactoring

* addon cleanup ([864eaef](https://github.com/K4zoku/FF-WebHID/commit/864eaef8aa90411e7e02b31c490ca9a43bb350fe))
* **addon:** cleanup deadcode, extract common utils ([4fac06d](https://github.com/K4zoku/FF-WebHID/commit/4fac06d143cc5142fa7a2ac5c124bf0225bf0021))
* buffer pool instead of alloc ([e1e4648](https://github.com/K4zoku/FF-WebHID/commit/e1e4648fec7a5822d74885d2bace8dd99b11676f))
* camelCase ([102cb5f](https://github.com/K4zoku/FF-WebHID/commit/102cb5ffb3e4988896d820c3aa1b1b134c084ef6))
* change polyfill log prefix ([fb85e82](https://github.com/K4zoku/FF-WebHID/commit/fb85e82d0e62f12e6d29d41bf2c516f68a2127ca))
* cleanup ([64b0eb9](https://github.com/K4zoku/FF-WebHID/commit/64b0eb91f01295606bcf0e4f8b49ef4de179d7a9))
* cleanup ([b4ec1ac](https://github.com/K4zoku/FF-WebHID/commit/b4ec1aca9df4baf69b376f63168de4949bac6e4f))
* cleanup dead code ([d4ee9fc](https://github.com/K4zoku/FF-WebHID/commit/d4ee9fc5206095659315ba7f5890c7b76aa6cf52))
* cleanup dead code ([57fc029](https://github.com/K4zoku/FF-WebHID/commit/57fc029358db73f21172f4f91756d41b7a3b3d36))
* cleanup, ogranize code ([4384670](https://github.com/K4zoku/FF-WebHID/commit/43846704cfa122fa05426796c668ffe831d0db6b))
* extract common logger, error log, fallback handling ([b133a6b](https://github.com/K4zoku/FF-WebHID/commit/b133a6b1f4ade84c16b32febe1aef69a59670d1e))
* mchan for sab wake ([0abe670](https://github.com/K4zoku/FF-WebHID/commit/0abe67098bcc816c31df64519b30130a245f75f0))
* optimize binary size ([00be78d](https://github.com/K4zoku/FF-WebHID/commit/00be78dd8913d2fc9f4ba57b1d207ea8cb08db7c))
* polyfill weakmap ([602e503](https://github.com/K4zoku/FF-WebHID/commit/602e503c7bcb51056858a3f4139b2a5e53267477))
* reduce deps ([7ca2317](https://github.com/K4zoku/FF-WebHID/commit/7ca2317e9f803e34d51c14d7a0ed392f7f87211a))
* remove deadcode ([a6933ef](https://github.com/K4zoku/FF-WebHID/commit/a6933ef6065070551c5ca7c07d69c2ff823e5824))
* rename event ([5037b85](https://github.com/K4zoku/FF-WebHID/commit/5037b85cd998b865b5637fd7743af5fc827e653b))
* settings utils merge ([3acb6fe](https://github.com/K4zoku/FF-WebHID/commit/3acb6fe8a3318ba2d9fd054ed91abc7b333a0430))


### Documentation

* add AGENTS.md ([e44fa02](https://github.com/K4zoku/FF-WebHID/commit/e44fa02479b6130c587a43d23de47d6c057fda4b))
* add DATA_PATH.md ([e785098](https://github.com/K4zoku/FF-WebHID/commit/e7850981835f84533fe477d56d2fde3639ba7317))
* guide for daemon-as-nm-host ([9c321d7](https://github.com/K4zoku/FF-WebHID/commit/9c321d7eff7442bf9877f0c66c5986721b158dc6))
* update benchmark, add skill ([816d4fd](https://github.com/K4zoku/FF-WebHID/commit/816d4fdce4cef4157f0522b07ddebc8dad506188))
* update docs ([46b7f02](https://github.com/K4zoku/FF-WebHID/commit/46b7f02cfceac1e615ed025eccf8a73c7fdb3866))
* update docs ([3b01463](https://github.com/K4zoku/FF-WebHID/commit/3b01463afe054f291e249a23e51ad1459f6f6391))
* update docs ([6c5ac70](https://github.com/K4zoku/FF-WebHID/commit/6c5ac708d8d10364d964b28926047b2c09e72efd))
* update docs ([4b1cc0e](https://github.com/K4zoku/FF-WebHID/commit/4b1cc0eeb567ea98ba5d72dc24293aebb86a6bba))
* update documents ([386d2bc](https://github.com/K4zoku/FF-WebHID/commit/386d2bc58e00531a6dec57c4d667a2598ae589c9))
* update documents ([2f8a5eb](https://github.com/K4zoku/FF-WebHID/commit/2f8a5eb5d1d85ba737d464d3edb0297e1a2f7b1b))
* update README ([d749d9e](https://github.com/K4zoku/FF-WebHID/commit/d749d9e2bbb00e2ce8e9f16a7321e918603b19be))
* update readme, installation guide and data path ([7bdfd1d](https://github.com/K4zoku/FF-WebHID/commit/7bdfd1d805fdf30a1f09398c13a120023a16c9a4))


### CI/CD

* archive false for single file artifact ([cfc1a9d](https://github.com/K4zoku/FF-WebHID/commit/cfc1a9d03f226056f74a8175510fda6499388a61))
* optimize ci ([d64c9c8](https://github.com/K4zoku/FF-WebHID/commit/d64c9c81705241ad7f0835210e679bc23f9fe387))
* optimize even more ([bb57396](https://github.com/K4zoku/FF-WebHID/commit/bb573968c00bd6d57e9f3f43276ee7348250e456))
* organize steps ([ca6e79b](https://github.com/K4zoku/FF-WebHID/commit/ca6e79b547798e2a7fe5900be59ea39293560656))
* skip wasm build, addon build now run in parallel ([f9bdbd2](https://github.com/K4zoku/FF-WebHID/commit/f9bdbd2776f7e7ea2eb054554b3af5e99552d52d))
* split addon build ([7628444](https://github.com/K4zoku/FF-WebHID/commit/762844458a9eff5f51119d3a4e3332dd019f25e1))

## [1.6.6](https://github.com/K4zoku/FF-WebHID/compare/v1.6.5...v1.6.6) (2026-07-08)


### Bug Fixes

* chmod, add missing file ([d29707a](https://github.com/K4zoku/FF-WebHID/commit/d29707a749936f19c4ba8a9bbc4982b6ea2e0e92))
* makefile indentation ([9a77212](https://github.com/K4zoku/FF-WebHID/commit/9a772124a098e2cdcaf81e35bfc2831cb96f1a3d))
* repo root path ([88cba51](https://github.com/K4zoku/FF-WebHID/commit/88cba5114217dfe04e876ec9a1e7d43ffecc6e96))


### Code Refactoring

* cleanup ([4235800](https://github.com/K4zoku/FF-WebHID/commit/42358007cee0e51b5b9b8713c6f6c6c8783e7c42))


### Documentation

* add community standards documents ([470bf80](https://github.com/K4zoku/FF-WebHID/commit/470bf80ab9e89911d0b9bb828f740b6fa04c4de7))
* update installation guide ([6cc294e](https://github.com/K4zoku/FF-WebHID/commit/6cc294eda3dd53217e4e8ca75945ec99e6259709))


### CI/CD

* add aarch64 target ([7259513](https://github.com/K4zoku/FF-WebHID/commit/7259513f530ac1d8d31483aaa0ee48d4828f788d))
* build rpm and deb package ([f17bc8d](https://github.com/K4zoku/FF-WebHID/commit/f17bc8d1a382fc4eddff770b1ed8216368f3d48f))
* fix arm64 sources ([4aa06cb](https://github.com/K4zoku/FF-WebHID/commit/4aa06cb99a2a574501788f09af687c31086a872b))
* fix cross compile ([e0ec565](https://github.com/K4zoku/FF-WebHID/commit/e0ec565d990813c6af74171c6a9c1bdc2536bce9))
* fix libudev-dev:arm64 ([55c762a](https://github.com/K4zoku/FF-WebHID/commit/55c762a031fbbfe148226352581dcdb38ceada03))
* fix macos path ([7a86177](https://github.com/K4zoku/FF-WebHID/commit/7a8617736d5fd229112fe59a63e2c928880d501a))
* fix mkdir ([10dccd0](https://github.com/K4zoku/FF-WebHID/commit/10dccd05d5897b55b3650f7beedc7c48ac6e17df))
* fix rpm aarch64 build & separate linux artifacts ([cf2b145](https://github.com/K4zoku/FF-WebHID/commit/cf2b1457b1098d53ff8eb97b522d24f267e8161c))
* separate steps for setup arm64 cross-compilation sources ([84cc4d6](https://github.com/K4zoku/FF-WebHID/commit/84cc4d6ff1af9fe5ab8db36c151013526cb3ae87))
* split addon build, fix deb/rpm build ([0795776](https://github.com/K4zoku/FF-WebHID/commit/0795776f4258945f825e10d079cd993b6e0e6a53))
* truly universal macos binaries ([26c1180](https://github.com/K4zoku/FF-WebHID/commit/26c11802b0bc75ef3ab0fc5231ad01bbfb02cb4e))


### Chores

* add feature request template ([bc0cacd](https://github.com/K4zoku/FF-WebHID/commit/bc0cacd31652e3d77c334cba7a5f19d593b8a72b))

## [1.6.5](https://github.com/K4zoku/FF-WebHID/compare/v1.6.4...v1.6.5) (2026-07-08)


### Bug Fixes

* custom action ([c1bfb11](https://github.com/K4zoku/FF-WebHID/commit/c1bfb11d7fab888432d76363cfe6e544ab75cedf))
* wix schema ([fcca18c](https://github.com/K4zoku/FF-WebHID/commit/fcca18cd481a75f33c5013b7927d4d49f3899c29))


### CI/CD

* add msi build ([e5b5955](https://github.com/K4zoku/FF-WebHID/commit/e5b595524f1d59d1ffea7774044e6ddfcfc039c4))

## [1.6.4](https://github.com/K4zoku/FF-WebHID/compare/v1.6.3...v1.6.4) (2026-07-08)

## [1.6.3](https://github.com/K4zoku/FF-WebHID/compare/v1.6.2...v1.6.3) (2026-07-08)


### Features

* add --version ([646f475](https://github.com/K4zoku/FF-WebHID/commit/646f4751c4dbc38fe647e9af4952b850701528ff))
* add debug logging back ([993483c](https://github.com/K4zoku/FF-WebHID/commit/993483c3fd8c70f846e19e1badba6280038f3a92))
* nop logger, perf ([b83c53f](https://github.com/K4zoku/FF-WebHID/commit/b83c53f5c9490724f14ff57118216e008fae8539))


### Bug Fixes

* device picker wait for ready & COEP: credentialless ([beb5b14](https://github.com/K4zoku/FF-WebHID/commit/beb5b1430be70ecfdf3f049a07223fb89ca9bf2f))
* picker error display ([b837499](https://github.com/K4zoku/FF-WebHID/commit/b83749917cd4e5b63141fc59818dc6903ebb342f))
* sab fallback ([5dbb593](https://github.com/K4zoku/FF-WebHID/commit/5dbb593c7a6a0c4d060b464e232fdca83f5c5773))


### Chores

* add bug report template ([48ff62e](https://github.com/K4zoku/FF-WebHID/commit/48ff62e707602f59638bb9f1480ae8755d605ae6))
* add FUNDING.yml ([e8ed88c](https://github.com/K4zoku/FF-WebHID/commit/e8ed88cb4ee99fe9cc00182e5457491c47346fd2))
* update bug report template ([6dafa77](https://github.com/K4zoku/FF-WebHID/commit/6dafa777facfd7ad73064bd27c99ddde748fcdc3))

## [1.6.2](https://github.com/K4zoku/FF-WebHID/compare/v1.6.1...v1.6.2) (2026-07-06)


### Bug Fixes

* browser action ([7326544](https://github.com/K4zoku/FF-WebHID/commit/73265446ea406119b73a6ed2726451e34e0bf2a3))

## [1.6.1](https://github.com/K4zoku/FF-WebHID/compare/v1.6.0...v1.6.1) (2026-07-06)


### Features

* cross platform report descriptor ([f01b88d](https://github.com/K4zoku/FF-WebHID/commit/f01b88d43f37d28ab7cb484c3928643933b86a13))


### Chores

* add bump patch ([b1854c4](https://github.com/K4zoku/FF-WebHID/commit/b1854c4e14dcc63de0bd281ef7a184a37dfdc086))

## [1.6.0](https://github.com/K4zoku/FF-WebHID/compare/v1.5.3...v1.6.0) (2026-07-06)


### Features

* device count ([2f848af](https://github.com/K4zoku/FF-WebHID/commit/2f848af8d7ba081741b3ccca22aafca79b0589be))
* move dialog to shadow dom ([4167690](https://github.com/K4zoku/FF-WebHID/commit/416769032c1234c01b9817d4e0ab3c0191fbb334))
* sab slider ([227075e](https://github.com/K4zoku/FF-WebHID/commit/227075e778166b015d14d9d142ffd18316d4bca2))


### Bug Fixes

* using deprecated parameters warning ([a203e97](https://github.com/K4zoku/FF-WebHID/commit/a203e97ea922c0b13a681b8abfd14ad0af42dbbf))


### Code Refactoring

* cleanup ([85e80a7](https://github.com/K4zoku/FF-WebHID/commit/85e80a749e843ca42046ace6de21c83f104407fd))
* theme system + restructure addon directory ([4ddafa9](https://github.com/K4zoku/FF-WebHID/commit/4ddafa93feeded3a9ba2efaf832925e0857a347f))


### CI/CD

* temporary disable AMO upload ([08b10af](https://github.com/K4zoku/FF-WebHID/commit/08b10af82b516190da8a438b2fc5f03687d7e1cd))

## [1.5.3](https://github.com/K4zoku/FF-WebHID/compare/v1.5.2...v1.5.3) (2026-07-06)


### Chores

* centralize install flow in Makefile, drop scripts/ ([38efe95](https://github.com/K4zoku/FF-WebHID/commit/38efe95889fb7a2e502139183861e87b5c19a151))

## [1.5.2](https://github.com/K4zoku/FF-WebHID/compare/v1.5.1...v1.5.2) (2026-07-05)


### Bug Fixes

* AMO XSS warnings ([7220f35](https://github.com/K4zoku/FF-WebHID/commit/7220f3532a7acd92ed180ec35be892fad8b6d688))
* wasm import ([ef415c8](https://github.com/K4zoku/FF-WebHID/commit/ef415c81a639e1d8811c13bb975a8cf2905383ac))


### CI/CD

* add manual dispatch to release flow ([1698578](https://github.com/K4zoku/FF-WebHID/commit/16985789c8135c85a90bbd3347db4191f0fdfd6b))
* add version suffix ([362a1b3](https://github.com/K4zoku/FF-WebHID/commit/362a1b331a40569b2ad3d3ec9977795d3440c53b))
* fix conflicting file name ([030effa](https://github.com/K4zoku/FF-WebHID/commit/030effa41064c2af323ce7ce18f0f86c8df9705a))
* fix release manual dispatch ([0933959](https://github.com/K4zoku/FF-WebHID/commit/093395974ef43cf19b98690f155ae05ada118993))
* fix release permission ([d984337](https://github.com/K4zoku/FF-WebHID/commit/d984337fea024ab0ea1c3b8c87117cb6dc5fa51d))

## [1.5.1](https://github.com/K4zoku/FF-WebHID/compare/v1.5.0...v1.5.1) (2026-07-05)


### CI/CD

* filter build paths ([b03dcfc](https://github.com/K4zoku/FF-WebHID/commit/b03dcfc2942bded6467c3b69ce63c6beb1bce63b))
* fix release ci ([83300a3](https://github.com/K4zoku/FF-WebHID/commit/83300a3ed6b1538100d0d79113efe2934f8080bf))
* update ci flow ([51f020c](https://github.com/K4zoku/FF-WebHID/commit/51f020cbcb409b83961d141badb6cb97c0612988))


### Chores

* fix version bump ([c57242e](https://github.com/K4zoku/FF-WebHID/commit/c57242e162e1b66c8bbe889475e18cc37f88a3df))

## 1.5.0 (2026-07-05)


### Features

* add batching to stdout writer ([0ce4204](https://github.com/K4zoku/FF-WebHID/commit/0ce42045c07620a8af3fc91b8d3a6e8ae7260095))
* add device persistence and filtering for granted HID devices ([6c49178](https://github.com/K4zoku/FF-WebHID/commit/6c4917879fb050c0d24e88defca2449b49ce7db2))
* chromium-compatible HID collection normalization ([2f090fd](https://github.com/K4zoku/FF-WebHID/commit/2f090fdcb59c350a9e1547f787e382a756e05c34))
* cross platform support ([2a54501](https://github.com/K4zoku/FF-WebHID/commit/2a54501faea88e139c053ac1bd7d4a25ac6196ef))
* fire-and-forget sendReport mode ([972b85d](https://github.com/K4zoku/FF-WebHID/commit/972b85dd5aa53bd48e9acb04a9a61e55d2d9e769))
* full wasm parser ([bf65955](https://github.com/K4zoku/FF-WebHID/commit/bf65955a19efc0488349ace731d714ad6dd74caf))
* implement HID feature report read/write and expand report metadata ([fc3a98a](https://github.com/K4zoku/FF-WebHID/commit/fc3a98ab35b0cb49098b2f2f712ebde055a4fc30))
* implement websocket for daemon side ([b6989e0](https://github.com/K4zoku/FF-WebHID/commit/b6989e05076c0a3ed8592f560236f9a80ac8a87f))
* implement websocket in addon and nm side ([ae71580](https://github.com/K4zoku/FF-WebHID/commit/ae715801b9ac098591c125e0c7e653c93ef25252))
* initial WebHID implementation (daemon + addon) ([32b81a6](https://github.com/K4zoku/FF-WebHID/commit/32b81a62d72080df8a93ae2de29e66c4d4b9ad8b))
* log level ([3e372da](https://github.com/K4zoku/FF-WebHID/commit/3e372dab1cdbf3286e4c39744fca6b48067b64a5))
* migrate to hidapi, device_id now stable across platform ([b4b6716](https://github.com/K4zoku/FF-WebHID/commit/b4b6716c55b4ddcafa8a132e62d77bc2090fb2c9))
* namepipe on windows ([ffb7167](https://github.com/K4zoku/FF-WebHID/commit/ffb71678eabddeb8cb6d570ab56ca0366fdfcbbe))
* native hotplug monitor ([532d42b](https://github.com/K4zoku/FF-WebHID/commit/532d42bb88ccc3a3e8c5703055a5cd996dff6203))
* open device by path and support report IDs ([f7e233c](https://github.com/K4zoku/FF-WebHID/commit/f7e233c1b84371a73ff4320b04f973f7e07040e7))
* per-site settings ([7c69013](https://github.com/K4zoku/FF-WebHID/commit/7c69013b4bb55f0ed4998791edd22a0e58826370))
* reconnect ([5354ccd](https://github.com/K4zoku/FF-WebHID/commit/5354ccd3234c7fa293a0e1f8ee92a2f86182d83a))
* SAB capacity ([bf0bc9c](https://github.com/K4zoku/FF-WebHID/commit/bf0bc9c317e782b797036e9c106ae5789a94e1a2))
* SAB toggle ([8b40bc0](https://github.com/K4zoku/FF-WebHID/commit/8b40bc0954407647f3bdf7143875340cd416320d))
* security packaging ([d330401](https://github.com/K4zoku/FF-WebHID/commit/d330401c57d53e2cec0db19aa34a9bc7ea84eb06))
* settings page with perf logging toggle ([42a542f](https://github.com/K4zoku/FF-WebHID/commit/42a542f3171c5f714a26b6b250a9d0c28bd89c5a))
* store device hashes and parse HID descriptors ([d8f935a](https://github.com/K4zoku/FF-WebHID/commit/d8f935aabfd36b00860e9038f39a23193a8fbe10))
* strip CSP meta tags for wootility.io ([1be9897](https://github.com/K4zoku/FF-WebHID/commit/1be98972e1305d378a2dfd359ba9227e5d4aa4f5))
* switch to WebSocket data plane ([64e44da](https://github.com/K4zoku/FF-WebHID/commit/64e44da703ec11704eacfb581f0131bdeeca9c65))


### Bug Fixes

* add mut to task bindings for select! ([fa8f073](https://github.com/K4zoku/FF-WebHID/commit/fa8f073cb7b5a96593d48bc8ea7b1de183269a5a))
* audit fixes ([d1f3b08](https://github.com/K4zoku/FF-WebHID/commit/d1f3b0835c1a4f806f9e5e768810f769752380b3))
* build error ([4437168](https://github.com/K4zoku/FF-WebHID/commit/443716839cbf4194bd633f532631e45f9602eee0))
* dedup device ([e361222](https://github.com/K4zoku/FF-WebHID/commit/e36122238230362fa10938bae4b96ae6c4de56cc))
* final audit fixes ([9348fef](https://github.com/K4zoku/FF-WebHID/commit/9348fef912c51f12b35fda4d2de186b17acab34f))
* group dev ([72f6cf1](https://github.com/K4zoku/FF-WebHID/commit/72f6cf1885ceeee563e474a481b7c25e69b342a6))
* increase IPC and event channel capacities ([19c8168](https://github.com/K4zoku/FF-WebHID/commit/19c816810d03b40245a0ee5c9590ca20935adaf9))
* js parser ([c8c2d61](https://github.com/K4zoku/FF-WebHID/commit/c8c2d61733450c826d2c240b30a27a388e551fc7))
* link user32, silence warnings ([47e9c25](https://github.com/K4zoku/FF-WebHID/commit/47e9c25bd35ba869917edf61c6967397e59e21db))
* lock on device arc ([68ec20b](https://github.com/K4zoku/FF-WebHID/commit/68ec20bbfd2368f4c3aa2cea862eda6a577bdb98))
* macos unsafe extern + windows pipe split ([14cbc2a](https://github.com/K4zoku/FF-WebHID/commit/14cbc2ac651f1cddc897769531b9e58d604f9a71))
* missing traits ([368d580](https://github.com/K4zoku/FF-WebHID/commit/368d5804d6a2cb46b2660ebcc2d129777d3565b9))
* move session token to WebSocket subprotocol ([f511a7e](https://github.com/K4zoku/FF-WebHID/commit/f511a7e6f045cd5a4618529a32b904cefe1f69c3))
* revert to 666 permission ([b9af5b4](https://github.com/K4zoku/FF-WebHID/commit/b9af5b4f32d14c7b05e7bd6eda097e7343d19d68))
* sab size ([d5b63fc](https://github.com/K4zoku/FF-WebHID/commit/d5b63fc067d1abeae5dbd44c14fbebae7e7d8066))
* static traits ([f2348b9](https://github.com/K4zoku/FF-WebHID/commit/f2348b94e29d4ee44d6d19ba9a0f5e5e82146ff3))
* strict specs ([e36d53a](https://github.com/K4zoku/FF-WebHID/commit/e36d53a15aa590e1c18738493e97fe1b8bf68271))
* u16 slot, extend sab capacity ([3000afa](https://github.com/K4zoku/FF-WebHID/commit/3000afa91dc85a723e6c809806ea91de6680f1d6))
* unsafe extern block + remove unused type ([c313bc7](https://github.com/K4zoku/FF-WebHID/commit/c313bc7161864147438086ed2bd1d370ec1d96fa))
* use json type for manifest version bump ([a345750](https://github.com/K4zoku/FF-WebHID/commit/a345750d5d2d9b7b606b05c4eccb9103c5e6768f))
* variable length report ([cd6429a](https://github.com/K4zoku/FF-WebHID/commit/cd6429a245e6b9ecf5bf1b0f7ae8f7acfafcb02a))
* windows build ([4d45c42](https://github.com/K4zoku/FF-WebHID/commit/4d45c429ebb433099007dfdff76b958be246f244))
* windows hotplug via raw FFI, drop windows crate ([3470a4c](https://github.com/K4zoku/FF-WebHID/commit/3470a4c8bf4a3863c03a3a224c5383bcd7602324))


### Performance

* reduce lock contention in device manager ([541cec0](https://github.com/K4zoku/FF-WebHID/commit/541cec06f216e93bbfdd47acddfd623d0811d9fa))
* unbounded ([405d9c3](https://github.com/K4zoku/FF-WebHID/commit/405d9c3863f836d1f26669ca542c5cbbbbfe3160))


### Code Refactoring

* align IPC and native messaging actions with WebHID spec ([dcf23f2](https://github.com/K4zoku/FF-WebHID/commit/dcf23f2b7bf59caefdb54d233dfc924de06a6c3c))
* change default ws port ([5cf32cb](https://github.com/K4zoku/FF-WebHID/commit/5cf32cb70ae59015afbf2078f9852c108149bd92))
* cleanup dead code ([518117b](https://github.com/K4zoku/FF-WebHID/commit/518117bcbbf81a6529555943fe70a17c7e4810a8))
* cleanup, update to match current architecture ([2f94a38](https://github.com/K4zoku/FF-WebHID/commit/2f94a381f626cff04725afce4a310604f38920e3))
* consolidate hid-worker data plane flow ([422cb34](https://github.com/K4zoku/FF-WebHID/commit/422cb3431980c4f527352305d1c08f72f6a07e89))
* move modal css into dedicated CSS file and improve packaging ([17200ee](https://github.com/K4zoku/FF-WebHID/commit/17200eeb2cbfc28a07353a78ef0e357bad240da1))
* remove unused ([9ab4f37](https://github.com/K4zoku/FF-WebHID/commit/9ab4f3749770115a268a9cdeb04b1714685624d5))
* replace CSP stripping with native webextension implementation ([5a97c5b](https://github.com/K4zoku/FF-WebHID/commit/5a97c5b89ff26595861ddd4b152819781c989c11))
* replace innerHTML with DOM template for device list ([c8c7d74](https://github.com/K4zoku/FF-WebHID/commit/c8c7d7437092aab1cd20d2fcf9e56fb8e3b40d51))
* shorten addon name ([d66ebe6](https://github.com/K4zoku/FF-WebHID/commit/d66ebe6dcc6426e8e15093162bd3b5b1e71a2174))
* switch to BytesMut for efficient JSON framing ([7f8fc6d](https://github.com/K4zoku/FF-WebHID/commit/7f8fc6d4c7c805b0b61092fa2104292062da9668))


### Documentation

* move development.md to docs/ ([1d0a492](https://github.com/K4zoku/FF-WebHID/commit/1d0a4929823b81d7063f08e35232abbde2e0322a))
* rename project to FF-WebHID; drop Zen refs ([ee09211](https://github.com/K4zoku/FF-WebHID/commit/ee0921183810216ddf1b9c02a1eb16d0dfe8f2c7))
* restructure, separate architecture, add AMO link ([f0b9919](https://github.com/K4zoku/FF-WebHID/commit/f0b991904141576907edf1cd72f444c90cf62779))
* update document ([a74c735](https://github.com/K4zoku/FF-WebHID/commit/a74c73530279e3fea12442ade7ec8bfdbaabf6a0))
* update readme ([2d4e3f6](https://github.com/K4zoku/FF-WebHID/commit/2d4e3f679b42682aa22e7fb76d65ddad9d3197b1))
* update README and DEVELOPMENT ([5d50908](https://github.com/K4zoku/FF-WebHID/commit/5d50908abbac118f3a7cdb75e10fa5d40d099535))


### CI/CD

* add wasm build ([032e53b](https://github.com/K4zoku/FF-WebHID/commit/032e53bc55b46d85dd8dcfb9e1509efde4fd5c1e))
* add workflow ([fcfa56e](https://github.com/K4zoku/FF-WebHID/commit/fcfa56ec33e74646696a1335484452d851ed82de))
* fix xpi not getting uploaded ([23a72aa](https://github.com/K4zoku/FF-WebHID/commit/23a72aa5e8d73e549c65f8e54be6fb97ea7cd81e))


### Chores

* add LICENSE ([56caabe](https://github.com/K4zoku/FF-WebHID/commit/56caabe8c649edd0d25283930fb8139f2e3d7728))
* add release automation (commit-and-tag-version + CI) ([e89c5b6](https://github.com/K4zoku/FF-WebHID/commit/e89c5b6ea8dc4cb8c56714f3023c5a13d6c78ac6))
* bump addon version to 1.1 ([c36fb09](https://github.com/K4zoku/FF-WebHID/commit/c36fb094123351068187bc7ffbc4f1b73b259de8))
* bump version ([a2750ba](https://github.com/K4zoku/FF-WebHID/commit/a2750baf4bd4d163385df2e9c31f9013532e5918))
* bump version to 1.2 and remove csp manifest ([b5dac73](https://github.com/K4zoku/FF-WebHID/commit/b5dac731948af4e70f847ca53ffb2da6112511be))
* bump version to 1.3 ([126011a](https://github.com/K4zoku/FF-WebHID/commit/126011a2f1a3e6551f3e9c4a675122eb4b3c67c7))
* change id ([0e752ee](https://github.com/K4zoku/FF-WebHID/commit/0e752ee74c249a8d66e121a840558b34c7031521))
* ignore auto-built wasm-parser files ([c312150](https://github.com/K4zoku/FF-WebHID/commit/c312150acc7b9a5165e0fec80c1ebec1f8b6a77b))
* init ([382854d](https://github.com/K4zoku/FF-WebHID/commit/382854dcb927cf805fd08605c8fdf13889efe09b))
* update systemd unit ([2b4aa22](https://github.com/K4zoku/FF-WebHID/commit/2b4aa22c53150c067880b172330d1635a76e23ce))
