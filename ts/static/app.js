// Notification toast
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg text-white shadow-lg transition-all transform translate-y-0 opacity-100 ${
        type === 'success' ? 'bg-green-600' :
        type === 'error' ? 'bg-red-600' :
        'bg-gray-700'
    }`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Check URL params for success messages
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('spotify_connected')) {
        showToast('Spotify connected successfully!', 'success');
    }
    if (params.get('qobuz_connected')) {
        showToast('Qobuz connected successfully!', 'success');
    }

    // Clean up URL
    if (params.toString()) {
        history.replaceState({}, '', window.location.pathname);
    }
});
