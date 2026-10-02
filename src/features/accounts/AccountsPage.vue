<script setup lang="ts">
import { defineAsyncComponent, onScopeDispose, ref, shallowRef } from 'vue'
import PageHead from '../../ui/shell/PageHead.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import { accountsApi } from '../../api/accounts'
import { errorStatus } from '../../lib/errors'
import type { AccountsBackend, AccountsData } from '../../types'

// one chunk per backend: a CPA console never downloads the Magpie page, and the other way round
const CpaAccountsPage = defineAsyncComponent(() => import('./CpaAccountsPage.vue'))
const MagpieAccountsPage = defineAsyncComponent(() => import('./MagpieAccountsPage.vue'))

/**
 * /accounts: one route, two backends. GET /api/accounts says which one serves the accounts —
 * `cpa` (GATEWAY_ENGINE=cpa, or magpie with the CPA control plane) keeps today's page and endpoints untouched;
 * `magpie` / `magpie-unavailable` get the Magpie page, which reuses this first answer. A server without the
 * route (404) is a CPA server. Any other failure lands on the Magpie page, whose own loop retries and hands
 * back to the CPA page if the answer turns out to be `cpa`.
 */
const mode = ref<'probe' | 'cpa' | 'magpie'>('probe')
const seed = shallowRef<AccountsData | null>(null)
const controller = new AbortController()
onScopeDispose(() => controller.abort())

async function probe() {
  try {
    const data = await accountsApi.list(controller.signal)
    seed.value = data
    mode.value = data.backend === 'cpa' ? 'cpa' : 'magpie'
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') return
    mode.value = errorStatus(error) === 404 ? 'cpa' : 'magpie'
  }
}
void probe()

function onBackend(backend: AccountsBackend) {
  if (backend === 'cpa') mode.value = 'cpa'
}
</script>

<template>
  <CpaAccountsPage v-if="mode === 'cpa'" />
  <MagpieAccountsPage v-else-if="mode === 'magpie'" :seed="seed" @backend="onBackend" />
  <div v-else class="ui-page" aria-busy="true">
    <PageHead title="账号" />
    <StateBlock state="loading" :rows="6" :cols="['96px', '1fr', '320px', '32px']" />
  </div>
</template>
