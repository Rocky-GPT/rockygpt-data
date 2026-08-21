/**
 * @module directory/types
 * Type definitions for the campus directory system.
 *
 * Covers office contacts, faculty/staff profiles, and the normalised
 * search-index shape consumed by the directory API and modal UI.
 */

/**
 * Top-level directory buckets shown in the directory modal and API response.
 */
export type DirectoryTab = 'Offices' | 'Staff & Faculty' | 'Others';

/**
 * Static campus office contact with routing hints for common student needs.
 */
export interface OfficeDirectoryContact {
  name: string;
  phone: string;
  category: string;
  email?: string;
  department: string;
  office?: string;
  helpsWith: string[];
}

/**
 * Static non-faculty contact entry, usually for people or services outside the faculty dataset.
 */
export interface OtherDirectoryContact {
  name: string;
  title: string;
  unit?: string;
  email?: string;
  phone?: string;
  office?: string;
  profileUrl?: string;
}

/**
 * Person record normalized from the faculty and staff source data.
 */
export interface FacultyStaffContact {
  name: string;
  title?: string;
  school?: string;
  email?: string;
  phone?: string;
  office?: string;
  profileUrl?: string;
  imageUrl?: string;
}

/**
 * Search-ready directory record combining office, faculty/staff, and static contact sources.
 */
export interface NormalizedDirectoryContact {
  id: string;
  bucket: DirectoryTab;
  kind: 'office' | 'person';
  source: 'office-static' | 'faculty-dataset' | 'other-static';
  name: string;
  title?: string;
  category?: string;
  department?: string;
  school?: string;
  unit?: string;
  email?: string;
  phone?: string;
  office?: string;
  profileUrl?: string;
  imageUrl?: string;
  helpsWith?: string[];
  searchText: string;
}

/**
 * Summary counts for each directory bucket.
 */
export interface DirectoryCounts {
  offices: number;
  staffFaculty: number;
  others: number;
  total: number;
}

/**
 * Full directory API payload consumed by the directory modal.
 */
export interface DirectoryApiResponse {
  offices: OfficeDirectoryContact[];
  facultyStaff: FacultyStaffContact[];
  others: OtherDirectoryContact[];
  allContacts: NormalizedDirectoryContact[];
  counts: DirectoryCounts;
  total: number;
  generatedAt: string;
  releaseVersion?: string;
}
