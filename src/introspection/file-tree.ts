import type { SyncedFileInfo, FileTreeNode } from '../types/index.js';

/**
 * Internal mutable node used during tree construction.
 */
interface MutableTreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children: Map<string, MutableTreeNode>;
  size?: number;
  blobName?: string;
}

/**
 * Build a hierarchical file tree from a flat list of synced files.
 *
 * The returned array contains root-level nodes. Directories are sorted
 * before files at each level; within each group, nodes are sorted
 * alphabetically by name.
 *
 * @param syncedFiles - Flat list of synced file info objects.
 * @returns Array of root-level FileTreeNode objects.
 */
export function buildFileTree(syncedFiles: readonly SyncedFileInfo[]): FileTreeNode[] {
  if (syncedFiles.length === 0) {
    return [];
  }

  // Root is a virtual directory node whose children become the returned array
  const root: MutableTreeNode = {
    name: '',
    type: 'directory',
    path: '',
    children: new Map(),
  };

  for (const file of syncedFiles) {
    const segments = file.localPath.replace(/\\/g, '/').split('/');
    let current = root;

    // Create/traverse intermediate directory nodes
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const dirPath = segments.slice(0, i + 1).join('/');

      if (!current.children.has(segment)) {
        current.children.set(segment, {
          name: segment,
          type: 'directory',
          path: dirPath,
          children: new Map(),
        });
      }
      current = current.children.get(segment)!;
    }

    // Create the file leaf node
    const fileName = segments[segments.length - 1];
    current.children.set(fileName, {
      name: fileName,
      type: 'file',
      path: file.localPath.replace(/\\/g, '/'),
      children: new Map(),
      size: file.size,
      blobName: file.blobName,
    });
  }

  return [...(convertToReadonly(root).children ?? [])];
}

/**
 * Recursively convert a MutableTreeNode to a readonly FileTreeNode.
 * Sorts children: directories first, then files, alphabetically within each group.
 */
function convertToReadonly(node: MutableTreeNode): FileTreeNode {
  if (node.type === 'file') {
    return {
      name: node.name,
      type: 'file',
      path: node.path,
      size: node.size,
      blobName: node.blobName,
    };
  }

  const childArray = Array.from(node.children.values());

  // Sort: directories first, then files; alphabetical within each group
  childArray.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const children = childArray.map(convertToReadonly);

  return {
    name: node.name,
    type: 'directory',
    path: node.path,
    ...(children.length > 0 ? { children } : {}),
  };
}
