// ---------- CONFIG ----------
const AUTHORIZED_USERS = [
    'f9d3022829fb47434e4a7a74634c7758d4a3c862d235c473a95a4382f70904c9',
    'bcb464fc3b2a546d016383fe1a281208d1260d7e92be1177bc58c24c3053a5ce',
    'ff526c35d6ab167652e6f51378ad03b5000f9ef91c27be8dcdca7d6e597bfe86',
    'e49c2e49efbf54f5873976004e4735a09d9b332493803ba876b0478f5cfb9b1b'
];

// Correct SHA-256 hash of the password
const CORRECT_PASSWORD_HASH = 'b46f6277c093cd4bb3f682b1d2f4db7454ad57af36a509f5cff7a824802f4f19';

// Direct URL to Google Apps Script Web App
const GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby7tnDbkSUfVhh2uEh08inmURJmpF02plPRiQMmJUcEXuinFq88WZYW0GfpChx0otFJ/exec";

// Build the final URL
const WEB_APP_URL = GOOGLE_APPS_SCRIPT_URL;

// Initial state from localStorage to speed up initial load
const getInitialLinks = () => {
    try {
        const cached = localStorage.getItem('dsa_nexus_cache');
        if (cached) return JSON.parse(cached);
    } catch (e) { console.error('Cache error:', e); }
    return {
        morningLab: [], morningLabSolution: [], morningQuiz: [], morningQuizSolution: [],
        afternoonLab: [], afternoonLabSolution: [], afternoonQuiz: [], afternoonQuizSolution: []
    };
};

// ---------- STATE ----------
let currentUser = null;
let isAuthorized = false;
let sessionToken = null; 
let isFetchingLinks = false; 
let searchTerm = '';
let fileLinks = getInitialLinks();

// ---------- HELPERS ----------

// SHA-256 Hashing helper
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Get session and sheet category from UI category ID
function getSessionAndSheetCategory(id) {
    const isMorning = id.startsWith('morning');
    const session = isMorning ? 'Morning' : 'Afternoon';
    const catSuffix = id.replace(isMorning ? 'morning' : 'afternoon', '');
    
    // Map UI suffix to sheet category name
    const categoryMap = {
        'Lab': 'lab',
        'LabSolution': 'labSolution',
        'Quiz': 'quiz',
        'QuizSolution': 'quizSolution'
    };

    return { session, sheetCategory: categoryMap[catSuffix] || 'other' };
}

// Helper to capitalize category for internal keys
function capitalizeCategory(cat) {
    const map = {
        'lab': 'Lab',
        'labSolution': 'LabSolution',
        'quiz': 'Quiz',
        'quizSolution': 'QuizSolution'
    };
    return map[cat] || cat;
}

// ---------- NOTIFICATIONS ----------
function showToast(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle');
    
    toast.innerHTML = `
        <i class="fas ${icon}"></i>
        <div class="toast-message">${message}</div>
        <div class="toast-close"><i class="fas fa-times"></i></div>
    `;
    
    // Add click event for closing
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.onclick = () => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    };
    
    container.appendChild(toast);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }
    }, 5000);
}

function showError(msg) { showToast(msg, 'error'); }
function showSuccess(msg) { showToast(msg, 'success'); }

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const msgEl = document.getElementById('confirmMessage');
        const cancelBtn = document.getElementById('confirmCancel');
        const confirmBtn = document.getElementById('confirmBtn');
        
        if (!modal || !msgEl || !cancelBtn || !confirmBtn) {
            resolve(confirm(message));
            return;
        }
        
        msgEl.textContent = message;
        modal.style.display = 'block';
        
        const cleanup = (result) => {
            modal.style.display = 'none';
            cancelBtn.removeEventListener('click', onCancel);
            confirmBtn.removeEventListener('click', onConfirm);
            resolve(result);
        };
        
        const onCancel = () => cleanup(false);
        const onConfirm = () => cleanup(true);
        
        cancelBtn.addEventListener('click', onCancel);
        confirmBtn.addEventListener('click', onConfirm);
    });
}

// ---------- AUTH ----------
async function handleLogin(email, password) {
    if (!email) return showError('Please enter your email.');

    const emailHash = await sha256(email);

    if (AUTHORIZED_USERS.includes(emailHash)) {
        currentUser = email;
        isAuthorized = true;
        sessionToken = password; // Use the password as the auth token
        updateUI();
        document.getElementById('loginModal').style.display = 'none';
        showSuccess(`Welcome ${email.split('@')[0]}! You can now add links.`);
    } else showError('You are not authorized.');
}

function logout() {
    currentUser = null;
    isAuthorized = false;
    sessionToken = null;
    updateUI();
    showSuccess('Successfully signed out!');
}

// ---------- UI ----------
function updateUI() {
    document.getElementById('loginBtn').style.display = isAuthorized ? 'none' : 'flex';
    document.getElementById('logoutBtn').style.display = isAuthorized ? 'flex' : 'none';
    document.getElementById('userDisplay').textContent = currentUser ? currentUser.split('@')[0] : '';

    const uploadAreas = [
        'morningLabUploadArea', 'morningLabSolutionUploadArea',
        'morningQuizUploadArea', 'morningQuizSolutionUploadArea',
        'afternoonLabUploadArea', 'afternoonLabSolutionUploadArea',
        'afternoonQuizUploadArea', 'afternoonQuizSolutionUploadArea'
    ];

    uploadAreas.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isAuthorized ? 'block' : 'none';
    });

    displayFiles(); // Instant render from memory
}

// ---------- FILE/LINK HANDLING ----------

async function copyToClipboard(text, name) {
    try {
        await navigator.clipboard.writeText(text);
        showSuccess(`Link for "${name}" copied to clipboard!`);
    } catch (err) {
        console.error('Failed to copy:', err);
        showError('Could not copy link.');
    }
}

// Generic API request handler
async function apiRequest(body) {
    const res = await fetch(WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, token: sessionToken })
    });

    if (!res.ok) throw new Error(`Network response was not ok: ${res.status}`);

    const responseText = await res.text();
    try {
        return JSON.parse(responseText);
    } catch (e) {
        throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}`);
    }
}

// Upload a new link
async function uploadLink(category) {
    if (!isAuthorized) return showError('You are not authorized.');
    
    const linkInput = document.getElementById(`${category}LinkInput`);
    const nameInput = document.getElementById(`${category}NameInput`);
    const url = linkInput.value.trim();
    const name = nameInput.value.trim();

    if (!url || !name) return showError('Please enter both a name and a link.');

    // Optimistic Update
    const { session, sheetCategory } = getSessionAndSheetCategory(category);
    const tempId = Date.now();
    const optimisticFile = { name, url, tempId, optimistic: true };
    
    // Push to local memory and render immediately
    fileLinks[category].push(optimisticFile);
    displayFiles();
    
    // Clear inputs immediately
    linkInput.value = '';
    nameInput.value = '';
    showSuccess(`Adding "${name}"...`);

    try {
        const data = await apiRequest({ 
            action: 'add', 
            session, 
            category: sheetCategory, 
            name, 
            url 
        });

        if (data.success) {
            showSuccess(`Link "${name}" added successfully!`);
            await fetchLinksData(); // Refresh to get the real data from server
        } else {
            // Rollback on failure
            fileLinks[category] = fileLinks[category].filter(f => f.tempId !== tempId);
            displayFiles();
            showError(data.message || 'Failed to save link.');
        }
    } catch (err) {
        // Rollback on failure
        fileLinks[category] = fileLinks[category].filter(f => f.tempId !== tempId);
        displayFiles();
        console.error(err);
        showError('Error uploading link.');
    }
}

// Delete a link
async function deleteLink(category, index) {
    if (!isAuthorized) return showError('Not authorized.');
    
    const file = fileLinks[category][index];
    if (!file) return showError('Link not found.');
    
    const confirmed = await customConfirm(`Are you sure you want to delete "${file.name}"?`);
    if (!confirmed) return;

    // Optimistic Update
    const originalFile = fileLinks[category][index];
    fileLinks[category].splice(index, 1);
    displayFiles();
    showSuccess(`Deleting "${file.name}"...`);

    try {
        const { session, sheetCategory } = getSessionAndSheetCategory(category);
        const data = await apiRequest({
            action: 'delete',
            session,
            category: sheetCategory,
            name: file.name,
            url: file.url
        });

        if (data.success) {
            showSuccess(`"${file.name}" deleted successfully!`);
            await fetchLinksData(); // Sync with server
        } else {
            // Rollback
            fileLinks[category].splice(index, 0, originalFile);
            displayFiles();
            showError(data.message || 'Failed to delete link');
        }
    } catch (err) {
        // Rollback
        fileLinks[category].splice(index, 0, originalFile);
        displayFiles();
        console.error(err);
        showError('Error deleting link');
    }
}


// ---------- RENDER FILES ----------

// Fetch data from Google Sheets
async function fetchLinksData() {
    if (isFetchingLinks) return;
    isFetchingLinks = true;

    try {
        const res = await fetch(`${WEB_APP_URL}?action=list`, {
            method: 'GET'
        });
        
        if (!res.ok) throw new Error(`Network response was not ok: ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "Failed to load sheet data");

        const localFileLinks = {
            morningLab: [],
            morningLabSolution: [],
            morningQuiz: [],
            morningQuizSolution: [],
            afternoonLab: [],
            afternoonLabSolution: [],
            afternoonQuiz: [],
            afternoonQuizSolution: []
        };

        ["Morning", "Afternoon"].forEach(session => {
            const sessionData = data.data[session] || [];
            sessionData.forEach(row => {
                const sessionLower = session.toLowerCase();
                const categoryKey = capitalizeCategory(row.category);
                const key = `${sessionLower}${categoryKey}`;
                
                if (localFileLinks[key]) {
                    const isDuplicate = localFileLinks[key].some(f => f.name === row.name && f.url === row.url);
                    if (!isDuplicate) {
                        localFileLinks[key].push({ name: row.name, url: row.url });
                    }
                }
            });
        });

        fileLinks = localFileLinks;
        localStorage.setItem('dsa_nexus_cache', JSON.stringify(fileLinks));
        displayFiles();

    } catch (err) {
        console.error("Error loading sheets:", err);
        showError("Failed to load morning/afternoon links. Please try again later.");
    } finally {
        isFetchingLinks = false;
    }
}

// Update DOM based on current fileLinks and authorization status
function displayFiles() {
    const containerIds = Object.keys(fileLinks);
    const hasSearch = searchTerm.length > 0;
    
    // Batch UI updates using requestAnimationFrame
    requestAnimationFrame(() => {
        const normalizeUrl = (url) => {
            if (!url) return '#';
            url = url.trim();
            if (/^https?:\/\//i.test(url)) return url;
            if (/^www\./i.test(url)) return `https://${url}`;
            return url;
        };

        const getFileIcon = (url) => {
            const normalized = normalizeUrl(url);
            if (normalized.includes('docs.google.com/document/d/')) return 'fa-file-pdf';
            if (/^https?:\/\//i.test(normalized)) return 'fa-external-link-alt';
            
            const ext = url.split('.').pop()?.toLowerCase();
            const iconMap = {
                'pdf': 'fa-file-pdf', 'doc': 'fa-file-pdf', 'docx': 'fa-file-pdf',
                'jpg': 'fa-file-image', 'jpeg': 'fa-file-image', 'png': 'fa-file-image', 'gif': 'fa-file-image', 'svg': 'fa-file-image',
                'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
                'html': 'fa-file-code', 'htm': 'fa-file-code'
            };
            return iconMap[ext] || 'fa-file';
        };

        containerIds.forEach(category => {
            const container = document.getElementById(`${category}Files`);
            if (!container) return;

            let filteredLinks = fileLinks[category];
            if (hasSearch) {
                filteredLinks = filteredLinks.filter(f => 
                    f.name.toLowerCase().includes(searchTerm.toLowerCase())
                );
            }

            if (filteredLinks.length === 0) {
                const emptyMsg = hasSearch ? 'No matching resources' : 'No files available';
                container.innerHTML = `<div class="file-item empty"><i class="fas fa-inbox"></i> ${emptyMsg}</div>`;
                return;
            }

            const fragment = document.createDocumentFragment();
            filteredLinks.forEach((file, index) => {
                const normalizedUrl = normalizeUrl(file.url);
                const isExternal = /^https?:\/\//i.test(normalizedUrl);
                const iconClass = getFileIcon(file.url);
                
                const div = document.createElement('div');
                div.className = `file-item ${file.optimistic ? 'optimistic' : ''}`;
                div.setAttribute('role', 'button');
                div.setAttribute('tabindex', '0');
                div.setAttribute('aria-label', `Open ${file.name}`);
                
                div.onclick = (e) => {
                    if (e.target.closest('.btn-delete') || e.target.closest('.btn-copy')) return;
                    window.open(normalizedUrl, '_blank', isExternal ? 'noopener,noreferrer' : '');
                };

                div.onkeydown = (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        div.click();
                    }
                };
                
                div.innerHTML = `
                    <div class="file-icon"><i class="fas ${iconClass}"></i></div>
                    <div class="file-name" title="${file.name}">${file.name}</div>
                    ${file.optimistic ? '<div class="optimistic-spinner"><i class="fas fa-spinner fa-spin"></i></div>' : ''}
                    <div class="file-actions">
                        <button class="btn-copy" onclick="event.stopPropagation(); copyToClipboard('${normalizedUrl}', '${file.name.replace(/'/g, "\\'")}')" title="Copy Link">
                            <i class="fas fa-copy"></i> Copy
                        </button>
                        ${isAuthorized ? `
                        <button class="btn-delete" onclick="event.stopPropagation(); deleteLink('${category}',${index})" title="Delete ${file.name}">
                            <i class="fas fa-trash"></i> Delete
                        </button>` : ''}
                    </div>
                `;
                fragment.appendChild(div);
            });
            
            container.innerHTML = '';
            container.appendChild(fragment);
        });
    });
}





// ---------- INITIALIZE ----------
document.addEventListener('DOMContentLoaded', () => {
    // Show skeletons initially
    const containerIds = Object.keys(fileLinks);
    containerIds.forEach(category => {
        const container = document.getElementById(`${category}Files`);
        if (container) {
            container.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
        }
    });

    updateUI();
    fetchLinksData();

    // Search logic
    const searchInput = document.getElementById('resourceSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchTerm = e.target.value;
            displayFiles();
        });
    }

    // Back to top logic
    const backToTopBtn = document.getElementById('backToTop');
    if (backToTopBtn) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 300) {
                backToTopBtn.classList.add('visible');
            } else {
                backToTopBtn.classList.remove('visible');
            }
        });
        backToTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Login modal logic
    const loginModal = document.getElementById('loginModal');
    document.getElementById('loginBtn').onclick = () => loginModal.style.display = 'block';
    document.querySelector('#loginModal .close').onclick = () => loginModal.style.display = 'none';
    window.onclick = (e) => { if (e.target === loginModal) loginModal.style.display = 'none'; };

    document.getElementById('logoutBtn').onclick = logout;

    // Login form submission
    document.getElementById('emailLoginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value.trim();
        
        const hexHash = await sha256(password);
        if (hexHash !== CORRECT_PASSWORD_HASH) return showError('Incorrect password.');
        await handleLogin(email, password);
    });
});

// Finalized the website without AI