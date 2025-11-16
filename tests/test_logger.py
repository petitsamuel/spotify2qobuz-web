"""Unit tests for logger utility."""

import pytest
import logging
from pathlib import Path
import tempfile
import shutil
from src.utils.logger import setup_logger, get_logger


class TestLogger:
    """Test cases for logger utility."""
    
    def test_setup_logger_console_only(self):
        """Test setting up logger with console output only."""
        logger = setup_logger("test_console")
        
        assert logger is not None
        assert logger.name == "test_console"
        assert logger.level == logging.INFO
        assert len(logger.handlers) >= 1
        
        # Check that at least one handler is a StreamHandler
        has_console = any(isinstance(h, logging.StreamHandler) for h in logger.handlers)
        assert has_console
        
        # Clean up
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            handler.close()
        logging.getLogger("test_console").handlers.clear()
    
    def test_setup_logger_with_file(self):
        """Test setting up logger with console and file output."""
        # Create temporary directory for log file
        temp_dir = tempfile.mkdtemp()
        log_file = Path(temp_dir) / "test.log"
        
        try:
            logger = setup_logger("test_file", str(log_file))
            
            assert logger is not None
            assert logger.name == "test_file"
            assert len(logger.handlers) >= 2
            
            # Check handlers
            has_console = any(isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler) for h in logger.handlers)
            has_file = any(isinstance(h, logging.FileHandler) for h in logger.handlers)
            assert has_console
            assert has_file
            
            # Test logging
            logger.info("Test message")
            
            # Check that file was created
            assert log_file.exists()
            
            # Clean up
            for handler in logger.handlers[:]:
                logger.removeHandler(handler)
                handler.close()
            logging.getLogger("test_file").handlers.clear()
        
        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)
    
    def test_setup_logger_no_duplicate_handlers(self):
        """Test that calling setup_logger twice doesn't create duplicate handlers."""
        logger1 = setup_logger("test_no_dup")
        handler_count = len(logger1.handlers)
        
        logger2 = setup_logger("test_no_dup")
        
        assert logger1 is logger2
        assert len(logger2.handlers) == handler_count
        
        # Clean up
        for handler in logger1.handlers[:]:
            logger1.removeHandler(handler)
            handler.close()
        logging.getLogger("test_no_dup").handlers.clear()
    
    def test_get_logger(self):
        """Test getting or creating a logger instance."""
        # Clean up any existing logger first
        existing_logger = logging.getLogger("spotify_qobuz_sync")
        for handler in existing_logger.handlers[:]:
            existing_logger.removeHandler(handler)
            handler.close()
        
        logger = get_logger()
        
        assert logger is not None
        assert logger.name == "spotify_qobuz_sync"
        assert len(logger.handlers) >= 1
        
        # Clean up
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            handler.close()
    
    def test_get_logger_custom_name(self):
        """Test getting logger with custom name."""
        # Clean up any existing logger first
        existing_logger = logging.getLogger("custom_logger")
        for handler in existing_logger.handlers[:]:
            existing_logger.removeHandler(handler)
            handler.close()
        
        logger = get_logger("custom_logger")
        
        assert logger is not None
        assert logger.name == "custom_logger"
        
        # Clean up
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            handler.close()
    
    def test_setup_logger_creates_directory(self):
        """Test that setup_logger creates log directory if it doesn't exist."""
        temp_dir = tempfile.mkdtemp()
        log_file = Path(temp_dir) / "subdir" / "nested" / "test.log"
        
        try:
            logger = setup_logger("test_mkdir", str(log_file))
            
            # Check that parent directories were created
            assert log_file.parent.exists()
            
            # Test logging
            logger.info("Test message")
            assert log_file.exists()
            
            # Clean up
            for handler in logger.handlers[:]:
                logger.removeHandler(handler)
                handler.close()
            logging.getLogger("test_mkdir").handlers.clear()
        
        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)
