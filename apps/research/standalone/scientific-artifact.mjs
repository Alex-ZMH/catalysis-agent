// Vendored from packages/shared-types/src/scientific-artifact.ts.
// Source SHA-256: 3ca30432c77bc47083cdc61512c90aba95b2b63730b9646ecb020be4c559f6e8
// Type annotations removed; classifier logic unchanged.
                                                                                      
                                                 
                    
                            
                    
                    
                           

/** MIME types emitted for every scientific result format supported by the
 * visualization adapters.  This is intentionally a browser-safe classifier:
 * it only uses a validated path/name, never file contents or provider MIME.
 */
                                              
                                       
                             
                               
                     
                            
                            
                              
                            

const STRUCTURE_EXTENSIONS                                                         = new Map([
  ['.cif', 'cif'],
  ['.vasp', 'vasp'],
  ['.poscar', 'vasp'],
  ['.contcar', 'vasp'],
  ['.xyz', 'xyz'],
  ['.extxyz', 'xyz'],
  ['.pdb', 'pdb'],
  ['.sdf', 'sdf'],
]         )

const STRUCTURE_MIME_TYPES                                                                                           = {
  cif: 'chemical/x-cif',
  vasp: 'chemical/x-vasp-poscar',
  xyz: 'chemical/x-xyz',
  pdb: 'chemical/x-pdb',
  sdf: 'chemical/x-mdl-sdfile',
}

const RESULT_EXACT_BASENAME_MIME_TYPES                                                        = new Map([
  ['poscar', 'chemical/x-vasp-poscar'],
  ['contcar', 'chemical/x-vasp-poscar'],
  ['xdatcar', 'chemical/x-vasp-xdatcar'],
  ['chgcar', 'chemical/x-vasp-chgcar'],
  ['elfcar', 'chemical/x-vasp-elfcar'],
  ['eigenval', 'chemical/x-vasp-eigenval'],
  ['doscar', 'chemical/x-vasp-doscar'],
]         )

const RESULT_EXTENSIONS_MIME_TYPES                                                        = new Map([
  ['.cif', 'chemical/x-cif'],
  ['.vasp', 'chemical/x-vasp-poscar'],
  ['.poscar', 'chemical/x-vasp-poscar'],
  ['.contcar', 'chemical/x-vasp-poscar'],
  ['.xyz', 'chemical/x-xyz'],
  ['.extxyz', 'chemical/x-xyz'],
  ['.pdb', 'chemical/x-pdb'],
  ['.sdf', 'chemical/x-mdl-sdfile'],
  ['.lammpstrj', 'application/x-lammps-dump'],
  ['.dump', 'application/x-lammps-dump'],
  ['.cube', 'chemical/x-cube'],
]         )

const RESULT_PATH_UNSAFE_PATTERN = /[\u0000-\u001f\u007f"\\]/

function safeScientificResultBasename(name        )                {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512 || /^[A-Za-z]:/.test(name)) return null
  if (name.startsWith('/') || name.includes('\\')) return null
  const segments = name.split('/')
  if (segments.some((segment) => (
    segment.length === 0 || segment.length > 500 || segment === '.' || segment === '..' ||
    RESULT_PATH_UNSAFE_PATTERN.test(segment)
  ))) return null
  const basename = segments.at(-1)?.toLowerCase() ?? ''
  if (basename.length === 0 || basename.startsWith('.')) return null
  return basename
}

export function scientificStructureArtifactFormat(name        )                                           {
  const basename = name.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (basename === 'poscar' || basename === 'contcar') return 'vasp'
  // Dotfiles such as `.POSCAR` are not structure filenames. They must not be
  // treated as extension-only matches for the allow-list above.
  if (basename.startsWith('.')) return null
  const dot = basename.lastIndexOf('.')
  return dot < 0 ? null : STRUCTURE_EXTENSIONS.get(basename.slice(dot)) ?? null
}

export function scientificStructureArtifactMimeType(name        )                                             {
  const format = scientificStructureArtifactFormat(name)
  return format === null ? null : STRUCTURE_MIME_TYPES[format]
}

/**
 * Classify a generated scientific result by its safe path/name.  Exact
 * extension and extensionless VASP names mirror the visualization adapters;
 * unsupported suffixes, dotfiles, traversal, and unsafe wire labels return
 * null.  The provider-supplied MIME and file contents are deliberately not
 * consulted.
 */
export function scientificResultArtifactMimeType(name        )                                          {
  const basename = safeScientificResultBasename(name)
  if (basename === null) return null
  const exactMimeType = RESULT_EXACT_BASENAME_MIME_TYPES.get(basename)
  if (exactMimeType !== undefined) return exactMimeType
  const dot = basename.lastIndexOf('.')
  return dot < 0 ? null : RESULT_EXTENSIONS_MIME_TYPES.get(basename.slice(dot)) ?? null
}
