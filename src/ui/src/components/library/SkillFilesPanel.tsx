import type { ReactElement } from "react";
import type { SkillFileRecord, SkillRecord } from "@shared/types";
import { MarkdownContent } from "../MarkdownContent";
import {
  isBinarySkillFile,
  skillFileDisplayContent,
  skillFileDisplaySize,
} from "../../skillFileDisplay";
import type { FileTreeNode, FileViewMode } from "./libraryTypes";
import {
  buildFileTree,
  contentDataUri,
  fileKind,
  formatJsonContent,
  formatYamlContent,
  isHtmlFile,
  isImageFile,
  isJsonFile,
  isMarkdownFile,
  isPreviewableFile,
  isYamlFile,
  previewNotice,
  readableSize,
  skillFiles,
  stripMarkdownFrontmatter,
} from "./libraryUtils";

interface SkillFilesPanelProps {
  skill: SkillRecord;
  activeFilePath: string | null;
  expandedFolders: Set<string>;
  viewMode: FileViewMode;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string, viewMode: FileViewMode) => void;
  onChangeViewMode: (mode: FileViewMode) => void;
}

const renderFilePreview = (file: SkillFileRecord): ReactElement => {
  const content = skillFileDisplayContent(file);

  if (isMarkdownFile(file.path) && !isBinarySkillFile(file)) {
    return (
      <div className="skill-preview-frame markdown-preview">
        <MarkdownContent content={stripMarkdownFrontmatter(content)} />
      </div>
    );
  }

  if (isHtmlFile(file.path) && !isBinarySkillFile(file)) {
    return (
      <iframe
        className="skill-html-preview"
        sandbox=""
        srcDoc={content}
        title={`Preview of ${file.path}`}
      />
    );
  }

  if (isJsonFile(file.path) && !isBinarySkillFile(file)) {
    return <pre className="skill-code-view formatted">{formatJsonContent(content)}</pre>;
  }

  if (isYamlFile(file.path) && !isBinarySkillFile(file)) {
    return <pre className="skill-code-view formatted">{formatYamlContent(content)}</pre>;
  }

  if (isImageFile(file.path)) {
    return (
      <div className="skill-asset-preview">
        <img src={contentDataUri(file)} alt={file.path} />
      </div>
    );
  }

  if (isBinarySkillFile(file)) {
    return <div className="empty-section compact">Binary asset. Preview is available only for supported image files.</div>;
  }

  return <div className="empty-section compact">{previewNotice(file.path)}</div>;
};

const renderFileTreeNode = (
  node: FileTreeNode,
  depth: number,
  props: SkillFilesPanelProps,
): ReactElement => {
  const isFolder = node.children.length > 0 && !node.file;
  const expanded = props.expandedFolders.has(node.path);
  const active = node.file?.path === props.activeFilePath;

  if (node.path === "") {
    return (
      <div className="skill-explorer-root" key="root">
        <div className="skill-explorer-project">{node.name}</div>
        {node.children.map((child) => renderFileTreeNode(child, 0, props))}
      </div>
    );
  }

  if (isFolder) {
    return (
      <div className="skill-explorer-branch" key={node.path}>
        <button
          className="skill-tree-row folder"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          type="button"
          onClick={() => props.onToggleFolder(node.path)}
        >
          <span className="tree-caret">{expanded ? "⌄" : "›"}</span>
          <span className="tree-icon">□</span>
          <span>{node.name}</span>
        </button>
        {expanded
          ? node.children.map((child) => renderFileTreeNode(child, depth + 1, props))
          : null}
      </div>
    );
  }

  return (
    <button
      key={node.path}
      className={active ? "skill-tree-row file active" : "skill-tree-row file"}
      style={{ paddingLeft: `${22 + depth * 14}px` }}
      type="button"
      onClick={() => {
        const path = node.file?.path ?? node.path;
        props.onSelectFile(path, isPreviewableFile(path) ? "preview" : "code");
      }}
    >
      <span className="tree-file-dot" />
      <span>{node.name}</span>
      <small>{fileKind(node.name)}</small>
    </button>
  );
};

export function SkillFilesPanel(props: SkillFilesPanelProps): ReactElement | null {
  const files = skillFiles(props.skill).slice().sort((a, b) => a.path.localeCompare(b.path));
  const tree = buildFileTree(files, props.skill.name);
  const activeFile =
    files.find((file) => file.path === props.activeFilePath) ?? files[0] ?? null;

  if (!activeFile) return null;

  return (
    <section className="skill-files-panel" aria-label="Skill files">
      <aside className="skill-file-explorer shadcn-card">
        <div className="skill-file-tree-heading">Project</div>
        {renderFileTreeNode(tree, 0, props)}
      </aside>
      <div className="skill-file-reader shadcn-card">
        <div className="skill-file-reader-heading">
          <div>
            <span>{activeFile.path}</span>
            <small>{readableSize(skillFileDisplaySize(activeFile))}{isBinarySkillFile(activeFile) ? " · binary" : ""}</small>
          </div>
          <div className="segmented-tabs" role="tablist" aria-label="File view mode">
            <button
              className={props.viewMode === "preview" ? "segmented-tab active" : "segmented-tab"}
              type="button"
              onClick={() => props.onChangeViewMode("preview")}
            >
              Preview
            </button>
            <button
              className={props.viewMode === "code" ? "segmented-tab active" : "segmented-tab"}
              type="button"
              onClick={() => props.onChangeViewMode("code")}
            >
              Code
            </button>
          </div>
        </div>
        {props.viewMode === "preview" ? (
          renderFilePreview(activeFile)
        ) : (
          isBinarySkillFile(activeFile) ? (
            <div className="empty-section compact">Binary asset. Code view is disabled.</div>
          ) : (
            <pre className="skill-code-view">{skillFileDisplayContent(activeFile)}</pre>
          )
        )}
      </div>
    </section>
  );
}
