<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">OVERVIEW</p>
        <h1>运行概览</h1>
        <p>系统健康状态、实时调用指标与服务网关状态监控</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="secondary" icon="i-carbon-renew">刷新</TxButton>
      </div>
    </div>

    <div class="grid-stats">
      <TxCard class="stat-card">
        <span class="stat-label">网关引擎</span>
        <div class="stat-val">
          <TxTag type="primary" size="md">Magpie Kernel</TxTag>
        </div>
      </TxCard>
      <TxCard class="stat-card">
        <span class="stat-label">RTK 状态</span>
        <div class="stat-val">
          <TxTag type="success" size="md">已接通 v0.50.0</TxTag>
        </div>
      </TxCard>
      <TxCard class="stat-card">
        <span class="stat-label">OAuth 状态</span>
        <div class="stat-val">
          <TxTag type="success" size="md">已接入</TxTag>
        </div>
      </TxCard>
      <TxCard class="stat-card">
        <span class="stat-label">系统环境</span>
        <div class="stat-val">
          <TxTag type="info" size="md">Local Mode</TxTag>
        </div>
      </TxCard>
    </div>

    <TxCard class="dashboard-section">
      <div class="card-head">
        <h2 class="section-title">核心监控与指标</h2>
      </div>
      <p class="muted text-sm">页面正在由 Tuffex 组件库提供完整支持。</p>
    </TxCard>
  </div>
</template>

<style scoped>
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px !important;
}

.stat-label {
  font-size: 13px;
  color: var(--tx-text-color-secondary);
}

.stat-val {
  font-size: 18px;
  font-weight: 600;
  display: flex;
  align-items: center;
}

.dashboard-section {
  padding: 20px !important;
}
</style>
