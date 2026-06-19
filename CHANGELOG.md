# Changelog

## [0.4.1](https://github.com/bo0tzz/bo0kkeeper/compare/v0.4.0...v0.4.1) (2026-06-19)


### Bug Fixes

* stop our outgoing invoices looping back; surface bank-tx link on /expenses; tidy Paperless inbox ([9e6aa06](https://github.com/bo0tzz/bo0kkeeper/commit/9e6aa06bf879e51f1e4bf95508b39a5d5a0da756))

## [0.4.0](https://github.com/bo0tzz/bo0kkeeper/compare/v0.3.0...v0.4.0) (2026-06-12)


### Features

* **invoices:** compose invoice from completed Wise transfer ([1da16cf](https://github.com/bo0tzz/bo0kkeeper/commit/1da16cf22291a3a8719688c92045f434e478bebe))

## [0.3.0](https://github.com/bo0tzz/bo0kkeeper/compare/v0.2.1...v0.3.0) (2026-06-05)


### Features

* **banking:** show balance asOf timestamp in drift line ([2bb87d0](https://github.com/bo0tzz/bo0kkeeper/commit/2bb87d09a64fd6e9e44c80815859264924bde9e8))


### Bug Fixes

* **banking:** use Enable Banking reference_date as balance asOf, not call-time ([b3de53e](https://github.com/bo0tzz/bo0kkeeper/commit/b3de53e1a616113ede56017aed22eb9ddaf9081b))
* **test:** set config defaults via vitest env, not leaking from sibling specs ([792079c](https://github.com/bo0tzz/bo0kkeeper/commit/792079c33a457d6720fb3fc0867e79e6fa983c10))
* **wise:** use Wise server-side 'created' as draft stateUpdatedAt; note honesty limit on reconcile ([bb6f15f](https://github.com/bo0tzz/bo0kkeeper/commit/bb6f15f248a2a751af23fe7e635022bb3283558c))

## [0.2.1](https://github.com/bo0tzz/bo0kkeeper/compare/v0.2.0...v0.2.1) (2026-06-03)


### Bug Fixes

* **wise:** mark balances#credit event as processed after drafting ([44bf9ba](https://github.com/bo0tzz/bo0kkeeper/commit/44bf9ba9daafa8cb2ff1613c39d0ed80e4a09dd7))
* **wise:** pass preferredPayIn=BALANCE on quote requests ([2009cbf](https://github.com/bo0tzz/bo0kkeeper/commit/2009cbfa0c2557390972c5e2883e0d9600f538a0))

## [0.2.0](https://github.com/bo0tzz/bo0kkeeper/compare/v0.1.0...v0.2.0) (2026-05-30)


### Features

* **web:** make compose BTW field class-aware ([d698402](https://github.com/bo0tzz/bo0kkeeper/commit/d69840230b7a75c8959043837ae9c1b931a84afc))


### Bug Fixes

* **invoices:** charge BTW on top of net line subtotal ([8e6db50](https://github.com/bo0tzz/bo0kkeeper/commit/8e6db50a2a04b97e4e5ff81658c3e260e071a887))
* **invoices:** never record BTW for out-of-scope client classes ([47f0013](https://github.com/bo0tzz/bo0kkeeper/commit/47f0013dfc2b128f5aecd5696657d3c7e0653498))
