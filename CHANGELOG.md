# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
