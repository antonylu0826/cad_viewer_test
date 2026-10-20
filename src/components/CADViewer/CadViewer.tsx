import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  AcDbDatabaseConverterManager,
  AcDbFileType,
  acdbHostApplicationServices,
} from '@mlightcad/data-model';
import { AcDbLibreDwgConverter } from '@mlightcad/libredwg-converter';
import {
  AcApDocManager,
  acedApplyUiTheme,
  AcEdOpenMode,
} from '@mlightcad/cad-simple-viewer';
import { acuiCreateSimpleUiPlugin } from '@mlightcad/cad-simple-ui-plugin';
import {
  FolderOpen,
  Maximize2,
  Minimize2,
  FileCode2,
  Upload,
  AlertTriangle,
  Loader2,
  Layers,
  ChevronDown,
} from 'lucide-react';
import './CadViewer.css';

declare global {
  interface Window {
    __cadManager?: AcApDocManager;
  }
}

let isConverterRegistered = false;

interface LayoutTabInfo {
  name: string;
  blockTableRecordId: string;
  tabOrder: number;
  isActive: boolean;
}

const DESKTOP_SAMPLES = [
  { name: 'mechanical_example-imperial.dwg', label: '機械三視圖 (Mechanical)' },
  { name: 'colorwh.dwg', label: '全彩色相環 (True Color)' },
  { name: 'plot_screening_and_fill_patterns.dwg', label: '出圖網點與填充圖樣 (Screening)' },
  { name: 'visualization_-_condominium_with_skylight.dwg', label: '天窗公寓建築 (Condominium)' },
  { name: 'blocks_and_tables_-_metric.dwg', label: '圖塊與表格 (Blocks & Tables)' },
];

export const CadViewer: React.FC = () => {
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('就緒，請選取 DWG 檔案');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [hasOpenedFile, setHasOpenedFile] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // 佈局 / 紙空間切換分頁列表
  const [layouts, setLayouts] = useState<LayoutTabInfo[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<string>('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cadHostRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeTimersRef = useRef<number[]>([]);

  // 清除所有未完成的定時器
  const clearAllTimers = useCallback(() => {
    activeTimersRef.current.forEach((id) => window.clearTimeout(id));
    activeTimersRef.current = [];
  }, []);

  // 安排可追蹤清理的定時器
  const scheduleTask = useCallback((fn: () => void, delayMs: number) => {
    const timerId = window.setTimeout(() => {
      activeTimersRef.current = activeTimersRef.current.filter((id) => id !== timerId);
      fn();
    }, delayMs);
    activeTimersRef.current.push(timerId);
  }, []);

  // 觸發全圖適配 (Zoom Extents)
  const triggerZoomExtents = useCallback((manager: AcApDocManager) => {
    try {
      manager.sendStringToExecute('zoom\nextents\n');
    } catch (e) {
      console.warn('全圖適配警告:', e);
    }
  }, []);

  // 確保 mlightcad 引擎與 DWG 轉換器及 UI 外掛初始化
  const ensureEngine = useCallback(async (): Promise<AcApDocManager> => {
    if (!cadHostRef.current) {
      throw new Error('畫布容器尚未準備就緒');
    }

    // 1. 註冊 LibreDWG WebAssembly 轉換器 (只註冊一次)
    if (!isConverterRegistered) {
      const dwgConverter = new AcDbLibreDwgConverter({
        useWorker: true,
        parserWorkerUrl: '/workers/libredwg-parser-worker.js',
      });
      AcDbDatabaseConverterManager.instance.register(
        AcDbFileType.DWG,
        dwgConverter
      );
      isConverterRegistered = true;
    }

    // 2. 獲取或建立 AcApDocManager 單例
    let manager = AcApDocManager.tryGetInstance();
    if (!manager) {
      acedApplyUiTheme('dark', cadHostRef.current);

      manager = AcApDocManager.createInstance({
        container: cadHostRef.current,
        autoResize: true,
        useMainThreadDraw: true,
        webworkerFileUrls: {
          dwgParser: '/workers/libredwg-parser-worker.js',
          mtextRender: '/workers/mtext-renderer-worker.js',
        },
      });

      if (!manager) {
        throw new Error('無法建立 AcApDocManager 實例');
      }

      // 載入 cad-viewer 原生完整工具列與側邊 dock 面板外掛
      await manager.pluginManager.loadPlugin(
        acuiCreateSimpleUiPlugin({
          host: cadHostRef.current,
          toolbar: {
            placement: 'left',
            items: 'default',
            collapsible: true,
            defaultCollapsed: false,
          },
          dockPanel: {
            defaultSide: 'left',
            defaultOpen: false,
            defaultWidth: 280,
          },
        })
      );
    }

    if (!manager) {
      throw new Error('無法取得 AcApDocManager 實例');
    }

    window.__cadManager = manager;
    return manager;
  }, []);

  // 刷新當前檔案的佈局清單
  const refreshLayouts = useCallback((manager: AcApDocManager) => {
    try {
      const db = manager.curDocument?.database;
      const layoutTable = (db as any)?.objects?.layout;
      if (!db || !layoutTable?.newIterator) {
        setLayouts([]);
        setActiveLayoutId('');
        return;
      }

      const list: LayoutTabInfo[] = [];
      const seen = new Set<string>();
      for (const layout of layoutTable.newIterator()) {
        const btrId = layout.blockTableRecordId;
        if (!btrId || seen.has(btrId)) continue;
        seen.add(btrId);
        list.push({
          name: layout.layoutName || 'Layout',
          tabOrder: Number(layout.tabOrder) || 0,
          blockTableRecordId: btrId,
          isActive: btrId === (db as any).currentSpaceId,
        });
      }

      list.sort((a, b) => a.tabOrder - b.tabOrder);
      if (list.length > 0) {
        setLayouts(list);
        const active = list.find((l) => l.isActive) || list[0];
        setActiveLayoutId(active.blockTableRecordId);
      } else {
        setLayouts([]);
        setActiveLayoutId('');
      }
    } catch (err) {
      console.warn('獲取佈局列表失敗:', err);
    }
  }, []);

  // 切換 Layout (Model / Layout1 / Layout2 ...)
  const handleSwitchLayout = useCallback(
    (btrId: string, name: string) => {
      try {
        const manager = AcApDocManager.tryGetInstance();
        if (!manager) return;

        acdbHostApplicationServices().layoutManager.setCurrentLayoutBtrId(btrId);
        setActiveLayoutId(btrId);
        setStatusMessage(`已切換至佈局：${name}`);

        // 切換後延遲執行全圖適配
        scheduleTask(() => {
          triggerZoomExtents(manager);
        }, 150);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('切換佈局失敗:', err);
        setErrorMessage(`切換佈局失敗: ${msg}`);
      }
    },
    [scheduleTask, triggerZoomExtents]
  );

  // 開啟 DWG 二進位 ArrayBuffer
  const openBuffer = useCallback(
    async (name: string, buffer: ArrayBuffer) => {
      clearAllTimers();
      try {
        setIsLoading(true);
        setErrorMessage(null);
        setCurrentFileName(name);
        setStatusMessage(`正在解析 ${name}... (LibreDWG WebAssembly)`);

        const manager = await ensureEngine();

        const openOptions = {
          mode: AcEdOpenMode.Read,
          progressiveRendering: true,
          drawNoPlotLayers: true,
          minimumChunkSize: 2000,
        };

        const success = await manager.openDocument(name, buffer, openOptions);

        if (success) {
          setHasOpenedFile(true);

          // 1. 自動觸發全圖適配 (雙重排程確保漸進渲染就緒後置中)
          scheduleTask(() => triggerZoomExtents(manager), 150);
          scheduleTask(() => triggerZoomExtents(manager), 600);

          // 2. 刷新佈局清單
          refreshLayouts(manager);

          // 3. 獲取圖紙統計資訊 (圖元數、圖層數)
          try {
            const db = manager.curDocument?.database;
            const modelCount = db?.tables?.blockTable?.modelSpace?.newIterator()?.count || 0;
            const layerCount = db?.tables?.layerTable?.newIterator()?.count || 0;
            setStatusMessage(`已載入: ${name}（模型空間圖元: ${modelCount}，圖層數: ${layerCount}）`);
          } catch {
            setStatusMessage(`已載入: ${name}`);
          }
        } else {
          setErrorMessage(`無法開啟 ${name}，請確認圖紙未受密碼保護或格式受損`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('開啟 DWG 失敗:', err);
        setErrorMessage(`開啟 DWG 失敗: ${msg}`);
      } finally {
        setIsLoading(false);
      }
    },
    [clearAllTimers, ensureEngine, refreshLayouts, scheduleTask, triggerZoomExtents]
  );

  // 載入預載樣例 (桌面 dwg samples 測試)
  const handleSelectSample = useCallback(
    async (sampleName: string) => {
      if (!sampleName) return;
      try {
        setIsLoading(true);
        setStatusMessage(`正在載入樣例: ${sampleName}...`);
        const resp = await fetch(`/test_samples/${sampleName}`);
        if (!resp.ok) {
          throw new Error(`無法取得樣例檔案 (HTTP ${resp.status})`);
        }
        const buffer = await resp.arrayBuffer();
        await openBuffer(sampleName, buffer);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`載入樣例失敗: ${msg}`);
        setIsLoading(false);
      }
    },
    [openBuffer]
  );

  // 本地選取檔案
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const buffer = await file.arrayBuffer();
        await openBuffer(file.name, buffer);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`讀取本地檔案錯誤: ${msg}`);
      }
      e.target.value = '';
    },
    [openBuffer]
  );

  // 拖放檔案處理
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext === 'dwg' || ext === 'dxf') {
          const buffer = await file.arrayBuffer();
          await openBuffer(file.name, buffer);
        } else {
          setErrorMessage('格式不支援：請拖放 .dwg 或 .dxf 格式檔案！');
        }
      }
    },
    [openBuffer]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  // 全螢幕切換
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // 監聽全螢幕狀態同步與定時器銷毀清理
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    ensureEngine().catch((err) => {
      console.warn('引擎預載失敗:', err);
    });

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      clearAllTimers();
    };
  }, [clearAllTimers, ensureEngine]);

  return (
    <div
      ref={containerRef}
      className={`cad-viewer-container ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        ref={fileInputRef}
        accept=".dwg,.dxf"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      {/* shadcn 極簡頂部工具列 */}
      <header className="cad-viewer-toolbar">
        <div className="toolbar-left">
          <FileCode2 className="file-icon" />
          <span className="file-title">
            {currentFileName || '2D CAD Viewer'}
          </span>
          {currentFileName && (
            <span className="format-tag">
              {currentFileName.split('.').pop()?.toUpperCase()}
            </span>
          )}
        </div>

        <div className="toolbar-right">
          {/* 桌面 DWG 樣例快速測試下拉選單 */}
          <div className="sample-selector-wrap">
            <select
              className="sample-select-dropdown"
              onChange={(e) => handleSelectSample(e.target.value)}
              value=""
              title="測試桌面 dwg samples 資料夾中的範例"
            >
              <option value="" disabled>
                測試樣例圖紙...
              </option>
              {DESKTOP_SAMPLES.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                </option>
              ))}
            </select>
            <ChevronDown className="dropdown-arrow" />
          </div>

          {/* 開啟本機 DWG 按鈕 (shadcn primary button) */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="shadcn-btn-primary"
            title="選取電腦中任意 .dwg 檔案"
          >
            <FolderOpen className="btn-icon" />
            <span>開啟本機 DWG</span>
          </button>

          {/* 全螢幕切換 */}
          <button
            onClick={toggleFullscreen}
            className="shadcn-btn-ghost icon-only"
            title={isFullscreen ? '結束全螢幕' : '全螢幕'}
          >
            {isFullscreen ? (
              <Minimize2 className="btn-icon" />
            ) : (
              <Maximize2 className="btn-icon" />
            )}
          </button>
        </div>
      </header>

      {/* 核心 CAD 呈現區域 (Canvas 掛載宿主) */}
      <main className="cad-viewer-body">
        {/* 錯誤警示卡片 */}
        {errorMessage && (
          <div className="error-banner">
            <AlertTriangle className="error-icon" />
            <div className="error-text">
              <span className="font-semibold">錯誤提示：</span>
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="error-close-btn"
            >
              ✕
            </button>
          </div>
        )}

        {/* 載入中 Spinner 指示 */}
        {isLoading && (
          <div className="loading-indicator">
            <Loader2 className="spin-icon" />
            <p className="loading-text">{statusMessage}</p>
          </div>
        )}

        {/* 未開檔時的 shadcn 簡約引導空狀態 */}
        {!hasOpenedFile && (
          <div className="empty-dropzone">
            <div className="empty-card">
              <Upload className="upload-icon" />
              <h3>開啟 AutoCAD DWG 檔案</h3>
              <p>
                基於 mlightcad 引擎，純瀏覽器端 WebAssembly 解析，安全零後端傳輸。
              </p>
              <div className="empty-actions">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="shadcn-btn-primary"
                >
                  <FolderOpen className="btn-icon" />
                  <span>選取電腦中的 DWG 檔案</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 拖放時的覆蓋遮罩指示 */}
        {isDragging && (
          <div className="drag-overlay">
            <Upload className="drag-overlay-icon" />
            <p>放開滑鼠以載入 DWG 圖紙</p>
          </div>
        )}

        {/* mlightcad Canvas 宿主容器 (100% 滿版) */}
        <div
          ref={cadHostRef}
          className="cad-canvas-host"
          style={{
            width: '100%',
            height: '100%',
            position: 'absolute',
            inset: 0,
          }}
        />

        {/* 底部 Layout 佈局切換分頁列 (Model / Layout 1 / Layout 2...) */}
        {hasOpenedFile && layouts.length > 0 && (
          <div className="cad-layout-tabs">
            <div className="layout-tab-header">
              <Layers className="layout-tab-icon" />
              <span>空間：</span>
            </div>
            <div className="layout-tab-list">
              {layouts.map((l) => {
                const isCurActive = l.blockTableRecordId === activeLayoutId;
                return (
                  <button
                    key={l.blockTableRecordId}
                    className={`layout-tab-btn ${isCurActive ? 'active' : ''}`}
                    onClick={() => handleSwitchLayout(l.blockTableRecordId, l.name)}
                    title={`切換至 ${l.name} 佈局`}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* 底部狀態列 */}
      <footer className="cad-viewer-footer">
        <div className="footer-left">
          <span className={`status-dot ${hasOpenedFile ? 'online' : 'idle'}`} />
          <span>{statusMessage}</span>
        </div>
        <div className="footer-right">
          <span>支援拖曳 .dwg 檔案至畫面直接開啟</span>
        </div>
      </footer>
    </div>
  );
};
