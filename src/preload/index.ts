import { buildBridge } from '@adaptivebehaviour/desktop/src/ipc/index';
import { contextBridge, ipcRenderer } from 'electron';

// The only bridge between the renderer and the main process: one named function per channel in the IPC contract,
// each of which resolves with a plain result. There is no generic "invoke any channel" function, and nothing
// from Node or Electron is exposed.
contextBridge.exposeInMainWorld('abBridge', buildBridge((channel, payload) => ipcRenderer.invoke(channel, payload)));

// What the open workspace holds (see main/workspace.ts). Creating and opening a workspace go through `abBridge.workspace`.
contextBridge.exposeInMainWorld('workspaceBridge', {
  current: () => ipcRenderer.invoke('terrane:workspace.current'),
  readNode: (id: string) => ipcRenderer.invoke('terrane:workspace.readNode', id),
  pickFile: () => ipcRenderer.invoke('terrane:workspace.pickFile'),
  pickImportFile: () => ipcRenderer.invoke('terrane:workspace.pickImportFile'),
  importFile: (keys: unknown) => ipcRenderer.invoke('terrane:workspace.importFile', keys),
  createNode: (input: unknown) => ipcRenderer.invoke('terrane:workspace.createNode', input),
  updateNode: (id: string, input: unknown) => ipcRenderer.invoke('terrane:workspace.updateNode', id, input),
  createLink: (source: string, target: string) => ipcRenderer.invoke('terrane:workspace.createLink', source, target),
  updateLink: (id: string, input: unknown) => ipcRenderer.invoke('terrane:workspace.updateLink', id, input),
  deleteNode: (id: string, keepCopy?: boolean) => ipcRenderer.invoke('terrane:workspace.deleteNode', id, keepCopy),
  deleteLink: (id: string) => ipcRenderer.invoke('terrane:workspace.deleteLink', id),
  saveLayout:(layout: unknown) => ipcRenderer.invoke('terrane:workspace.saveLayout', layout),
  createNodeType: (input: unknown) => ipcRenderer.invoke('terrane:workspace.createNodeType', input),
  updateNodeType: (id: string, input: unknown) => ipcRenderer.invoke('terrane:workspace.updateNodeType', id, input),
  deleteNodeType: (id: string) => ipcRenderer.invoke('terrane:workspace.deleteNodeType', id),
});
