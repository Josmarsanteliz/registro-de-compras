'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getRecords: () => ipcRenderer.invoke('db:records'),
  addRecord: (rec) => ipcRenderer.invoke('registro:add', rec),
  updateRecord: (rec) => ipcRenderer.invoke('registro:update', rec),
  deleteRecord: (id) => ipcRenderer.invoke('registro:delete', id),

  getLoans: () => ipcRenderer.invoke('loans:get'),
  addLoan: (payload) => ipcRenderer.invoke('loan:add', payload),
  updateLoan: (payload) => ipcRenderer.invoke('loan:update', payload),
  deleteLoan: (id) => ipcRenderer.invoke('loan:delete', id),
  payLoan: (id) => ipcRenderer.invoke('loan:pay', id),
  unpayLoan: (id) => ipcRenderer.invoke('loan:unpay', id),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:set', s),

  getTasa: () => ipcRenderer.invoke('tasa:get'),
  refreshTasa: () => ipcRenderer.invoke('tasa:refresh'),
  onTasaActualizada: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('tasa:actualizada', handler);
    return () => ipcRenderer.removeListener('tasa:actualizada', handler);
  },

  getMercado: () => ipcRenderer.invoke('mercado:get'),
  refreshMercado: () => ipcRenderer.invoke('mercado:refresh'),
  onMercadoActualizado: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('mercado:actualizado', handler);
    return () => ipcRenderer.removeListener('mercado:actualizado', handler);
  },

  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  exportCsv: () => ipcRenderer.invoke('backup:exportCsv'),
});